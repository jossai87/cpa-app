/**
 * Sales & Revenue chatbot Lambda — Bedrock tool use edition.
 *
 * POST /pos/chat
 *   Body: { messages: Array<{ role: 'user' | 'assistant'; content: string }> }
 *   Returns: { reply: string }
 *
 * The model is given a set of tools it can call to fetch any data it needs
 * from DynamoDB on demand. This means it can answer questions about returns,
 * specific date ranges, inventory details, purchasing, staff, etc. — anything
 * in the store's data — without us having to pre-load everything upfront.
 *
 * Tool call loop:
 *   1. Send user message + tool definitions to Bedrock
 *   2. If model returns toolUse → execute the tool → send toolResult back
 *   3. Repeat until model returns a text response (stopReason = end_turn)
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import * as salesTools from './tools';
import type { AttachmentRef, ToolContext } from './helpers';
import { todayStr } from './helpers';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambdaClient = new LambdaClient({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const MODEL_ID = process.env['BEDROCK_MODEL_ID'] ?? 'us.amazon.nova-pro-v1:0';
const GMAIL_ANALYSIS_FN = process.env['GMAIL_ANALYSIS_FN'] ?? 'foot-solutions-gmail-analysis';

// ── Helpers ──────────────────────────────────────────────────────────
// Date / number / vendor helpers live in `./helpers.ts` so the extracted
// per-tool functions in `./tools/*` and the dispatcher below share one
// source of truth.

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'call_inbox_assistant',
      description: `Search the owner's Gmail inbox cache to answer questions about emails, vendors, invoices, customer threads, or specific people. Use this when the question requires email context — e.g. "did Brooks email us?", "what invoices are pending?", "last email from Nancy?". Returns raw cache results that you should synthesize into a clear answer. ALWAYS announce to the user that you are checking the inbox before calling this tool.`,
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask the Inbox Assistant, phrased as a standalone query with full context.',
            },
          },
          required: ['question'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_vendor_contacts',
      description: 'Look up contact information for one or more vendors from the store\'s vendor directory. Returns phone, email, website, rep name, rep phone, rep email, and account number. ALWAYS call this first when asked about vendor contact info, account numbers, or rep details — before searching Gmail. Can look up a specific vendor by name, or return all vendors.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor_name: {
              type: 'string',
              description: 'Vendor name to look up (e.g. "Brooks", "Yaleet", "SHU-RE-NU"). Leave empty to return all vendors.',
            },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_sales_summary',
      description: 'Get sales revenue, ticket count, discounts, and avg ticket for a date range. Use this for questions about revenue, sales totals, daily/weekly/monthly performance, or comparisons.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Start date YYYY-MM-DD (Central Time)' },
            to_date: { type: 'string', description: 'End date YYYY-MM-DD (Central Time)' },
          },
          required: ['from_date', 'to_date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_returns_data',
      description: 'Get return rates and gross return amounts by brand for the current year. Use this for any questions about returns, refunds, or return rates.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_inventory',
      description: 'Get inventory summary, department breakdown, top/low margin items, and low-stock items (≤3 units). Use for questions about stock levels, margins, departments, or specific items.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['summary', 'low_stock', 'top_margin', 'low_margin', 'by_department', 'all'],
              description: 'Which section of inventory data to return',
            },
          },
          required: ['section'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_staff_performance',
      description: 'Get sales by staff member (sales rep) for a date range. Use for questions about who sold the most, staff rankings, or individual rep performance.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
          },
          required: ['from_date', 'to_date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_brand_performance',
      description: 'Get net sales, units sold, and transaction count by brand for the current year. Use for questions about which brands are selling best, brand comparisons, or brand-level revenue.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
            top_n: { type: 'number', description: 'Return only the top N brands by net sales (default 20)' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_purchasing',
      description: 'Get vendor list, open purchase orders, and vendor rankings by PO volume. Use for questions about vendors, purchase orders, open orders, or supplier relationships.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['vendors', 'open_orders', 'vendor_rank', 'all'],
              description: 'Which section of purchasing data to return',
            },
          },
          required: ['section'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_customer_insights',
      description: 'Get customer retention metrics: total customers, repeat vs new, repeat revenue. Use for questions about customer loyalty, repeat buyers, or customer counts.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_payment_methods',
      description: 'Get breakdown of sales by payment type (cash, credit, etc.) for a date range.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
          },
          required: ['from_date', 'to_date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_sync_status',
      description: 'Get the last time data was synced from Heartland POS, and the status of each sync section.',
      inputSchema: {
        json: { type: 'object', properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_hourly_heatmap',
      description: 'Get revenue by hour of day aggregated across a date range. Use for questions about peak hours, busiest times, staffing patterns, or "when do we sell the most". Returns total and average revenue per hour (0-23 in Central Time).',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
            day_of_week: { type: 'string', description: 'Optional: filter to a specific day name (Monday, Tuesday, ..., Saturday, Sunday)' },
          },
          required: ['from_date', 'to_date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_top_customers',
      description: 'Get the top customers by revenue for a date range. Use for questions about best customers, loyalty, or who spends the most. Returns name, total revenue, and visit count.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
            top_n: { type: 'number', description: 'Number of top customers to return (default 15, max 50)' },
          },
          required: ['from_date', 'to_date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_open_orders_detail',
      description: 'Get open/pending purchase orders with aging analysis. Can filter by vendor name. Use for questions about outstanding orders, what\'s on order, how long orders have been open, or total committed spend per vendor.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor_name: { type: 'string', description: 'Optional: filter to a specific vendor name (partial match)' },
            min_days_open: { type: 'number', description: 'Optional: only return orders open at least this many days' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_historical_comparison',
      description: 'Compare sales performance across different years or periods. Use for year-over-year questions like "how does this year compare to last year" or "what were sales in 2024 vs 2025". Returns brand-level net sales and transaction counts per year.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            years: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of years to compare, e.g. ["2024", "2025", "2026"]. Defaults to current + prior year.',
            },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_orthotics_commission',
      description: 'Get orthotics unit sales and commission breakdown by sales rep. Commission rules: $10/unit for units 1-10, $15/unit for unit 11+. Use for questions about Becky\'s commission, orthotics sales by rep, or commission owed.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', '7d', '30d', 'monthly', 'ytd'],
              description: 'Time period (default: ytd)',
            },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_tax_summary',
      description: 'Get the most recent CPA tax analysis session — form inputs (revenue, expenses, COGS, payroll, etc.) and AI-estimated results (federal tax, quarterly payments, key deductions). Use for questions about the tax form, what was entered, or estimated tax liability.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            tax_year: { type: 'string', description: 'Optional: specific tax year (e.g. "2025"). Defaults to most recent session.' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'cache_query',
      description: 'Search the local Gmail cache (rolling ~6 month copy of the inbox). Use to find emails about a vendor brand, customer inquiries, invoices, or specific senders. Combine vendor + since/until + kind for narrow results. Returns metadata; call cache_read for body.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: { type: 'string', description: 'Vendor brand (Brooks, Dansko, Aetrex, Hoka, etc.)' },
            kind: { type: 'string', enum: ['invoice', 'vendor', 'customer', 'internal'] },
            since: { type: 'string', description: 'YYYY-MM-DD inclusive' },
            until: { type: 'string', description: 'YYYY-MM-DD inclusive' },
            from: { type: 'string', description: 'From-header substring' },
            text: { type: 'string', description: 'Subject/snippet substring' },
            threadId: { type: 'string' },
            limit: { type: 'number', description: 'Default 25, max 100' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'cache_vendor_activity',
      description: "Get a vendor's email activity rollup over the last N days: message count, last contact date, top senders, top subjects, recent message IDs. Use when answering 'how active is Brooks' or 'when did we last hear from Aetrex'.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: { type: 'string' },
            days: { type: 'number', description: 'Default 90, max 365' },
          },
          required: ['vendor'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'cache_read',
      description: 'Read full body of a cached email by id (and dateOnly for speed). The response includes an `attachments` array — mention filenames to the user when present.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            dateOnly: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>, callerUserId?: string, attachmentCollector?: Array<{ messageId: string; subject?: string; attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> }>): Promise<string> {
  // Slim dispatcher — each tool's logic lives in `./tools/<name>.ts`.
  // The legacy `/pos/chat` Lambda is the only caller; the future Strands
  // Sales_Agent wraps these same functions as `tool({...})` callbacks
  // (Task 6.1 in the fs-assistant-orchestrator spec).
  const ctx: ToolContext = {
    docClient,
    tableName: TABLE_NAME,
    ownerUserId: OWNER_USER_ID,
    callerUserId,
    attachmentCollector: attachmentCollector as AttachmentRef[] | undefined,
  };
  const args = input as Record<string, never>;

  switch (name) {
    case 'call_inbox_assistant':       return salesTools.callInboxAssistant(args);
    case 'get_vendor_contacts':        return salesTools.getVendorContacts(args);
    case 'get_sales_summary':          return salesTools.getSalesSummary(args, ctx);
    case 'get_returns_data':           return salesTools.getReturnsData(args, ctx);
    case 'get_inventory':              return salesTools.getInventory(args, ctx);
    case 'get_staff_performance':      return salesTools.getStaffPerformance(args, ctx);
    case 'get_brand_performance':      return salesTools.getBrandPerformance(args, ctx);
    case 'get_purchasing':             return salesTools.getPurchasing(args, ctx);
    case 'get_customer_insights':      return salesTools.getCustomerInsights(args, ctx);
    case 'get_payment_methods':        return salesTools.getPaymentMethods(args, ctx);
    case 'get_sync_status':            return salesTools.getSyncStatus(args, ctx);
    case 'get_hourly_heatmap':         return salesTools.getHourlyHeatmap(args, ctx);
    case 'get_top_customers':          return salesTools.getTopCustomers(args, ctx);
    case 'get_open_orders_detail':     return salesTools.getOpenOrdersDetail(args, ctx);
    case 'get_historical_comparison':  return salesTools.getHistoricalComparison(args, ctx);
    case 'get_orthotics_commission':   return salesTools.getOrthoticsCommission(args, ctx);
    case 'get_tax_summary':            return salesTools.getTaxSummary(args, ctx);
    case 'cache_query':                return salesTools.cacheQuery(args);
    case 'cache_vendor_activity':      return salesTools.cacheVendorActivity(args);
    case 'cache_read':                 return salesTools.cacheRead(args, ctx);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── System prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const today = todayStr();
  return `You are a helpful business intelligence assistant for Foot Solutions Flower Mound, a specialty footwear retail store in Flower Mound, TX.

You have access to real-time data from the store's Heartland POS system via a set of tools. Use these tools to answer questions accurately.

Key facts:
- Today's date (Central Time): ${today}
- Store location: Flower Mound, TX (location ID 100006)
- Tax rate: 8.25% (Denton combined)
- Data is synced from Heartland every 6 hours

Guidelines:
- Always use tools to fetch data before answering — do not guess or make up numbers
- Format dollar amounts with $ and 2 decimal places
- When asked about "today", use date ${today}
- When asked about "this week", use the last 7 days
- When asked about "this month", use the last 30 days
- When asked about "YTD" or "this year", use ${today.slice(0, 4)}-01-01 to ${today}
- Be concise and direct — this is a business dashboard, not a chat app
- If a tool returns no data, say so clearly and suggest syncing

Tool selection guide:
- Revenue / sales totals → get_sales_summary
- Peak hours / busiest times → get_hourly_heatmap
- Top customers / loyalty → get_top_customers
- Staff performance / who sold most → get_staff_performance
- Orthotics commission (Becky) → get_orthotics_commission
- Brand performance / top brands → get_brand_performance
- Year-over-year / historical comparison → get_historical_comparison
- Returns / refunds by brand → get_returns_data
- Inventory / stock levels / margins → get_inventory
- Open orders / purchase orders / vendor spend → get_open_orders_detail
- Vendor list / vendor rankings → get_purchasing
- Customer retention / repeat buyers → get_customer_insights
- Payment methods (cash/card split) → get_payment_methods
- Tax form inputs / estimated liability → get_tax_summary
- Last sync time → get_sync_status
- Vendor contact info / account numbers → get_vendor_contacts
- Email / inbox questions (invoices, vendor emails, customer threads) → call_inbox_assistant

Cross-agent calling (IMPORTANT):
- When a question requires email or inbox context that POS data cannot answer, use call_inbox_assistant.
- ALWAYS tell the user first: "Let me check the inbox for that…" before calling the tool.
- The tool queries the Gmail cache directly and returns raw results — synthesize them into a clear answer.
- Examples: "did Brooks email us?", "any pending invoices?", "last email from Nancy?", "what did the vendor say about the price change?"
- Do NOT use call_inbox_assistant for purely numeric POS questions — use the POS tools instead.

Vendor contact info (IMPORTANT — follow this order):
1. ALWAYS call get_vendor_contacts FIRST for any question about vendor phone, email, rep name, account number, or website.
2. The directory has pre-loaded contact info for all major vendors. Account numbers are stored under rep.accountNumber.
3. Only fall back to Gmail cache tools if the directory returns found=false AND the user specifically needs email correspondence context.
4. When listing multiple vendors, call get_vendor_contacts once per vendor (or once with no vendor_name to get all).
5. If a vendor has no account number in the directory, say "not on file" — do NOT say "not available" or imply it can't be found.

Inbox-aware reasoning (use when a question would benefit from email context):
- You have a LOCAL CACHE of the owner's Gmail inbox (rolling ~6 month window) accessible via three tools: cache_query, cache_vendor_activity, cache_read.
- When a question is about a specific vendor or brand, prefer cache_vendor_activity(vendor, days) — gives last contact date, top senders, top subjects, recent message ids in one shot.
- For broader inbox digs use cache_query({ vendor, kind, since, until, from, text }). kind = invoice | vendor | customer | internal.
- Do NOT use Gmail tools for purely numeric POS questions (today's sales, top brands, etc.) — that's noise.
- Do NOT quote email bodies verbatim. Paraphrase, and cite the message id like "(msg 18a3f...)" — the app renders these as clickable Gmail links automatically. Do NOT write out full https://mail.google.com URLs.`.trim();
}

// ── Chat history handlers ─────────────────────────────────────────────
//
// Conversations are stored per-user in DynamoDB with a 30-day TTL.
// SK format: CHAT_HISTORY#<type>#<sessionId>
// type = 'sales' | 'inbox'

const HISTORY_TTL_DAYS = 30;

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO 8601
}

interface HistorySession {
  sessionId: string;
  type: 'sales' | 'inbox' | 'assistant';
  preview: string;       // first user message, truncated
  messages: HistoryMessage[];
  startedAt: string;
  lastMessageAt: string;
  ttl: number;           // epoch seconds
}

function historyTtl(): number {
  return Math.floor(Date.now() / 1000) + HISTORY_TTL_DAYS * 86400;
}

async function handleListHistory(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!userId) return json(401, { error: 'Unauthorized' });
  const type = event.queryStringParameters?.['type'] ?? 'sales';

  // ── ?type=all unified-list mode (Task 13.2) ─────────────────────
  // Queries CHAT_HISTORY#sales#*, CHAT_HISTORY#inbox#*, and
  // CHAT_HISTORY#assistant#*, caps each prefix at 50, and tags
  // legacy sessions with `legacy: true` + a `displayLabel` so the
  // unified `<FsAssistant />` history list can show
  //   "Sales (legacy)", "Inbox (legacy)", "FS Assistant"
  // (per design.md §Component 5 chat history endpoints / Req 10.4).
  if (type === 'all') {
    const PREFIXES: Array<{
      type: HistorySession['type'];
      legacy: boolean;
      displayLabel: string;
    }> = [
      { type: 'assistant', legacy: false, displayLabel: 'FS Assistant' },
      { type: 'sales', legacy: true, displayLabel: 'Sales (legacy)' },
      { type: 'inbox', legacy: true, displayLabel: 'Inbox (legacy)' },
    ];
    try {
      const groups = await Promise.all(
        PREFIXES.map(async ({ type: t, legacy, displayLabel }) => {
          const result = await docClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: {
              ':uid': userId,
              ':prefix': `CHAT_HISTORY#${t}#`,
            },
            ProjectionExpression: 'sessionId, #t, preview, startedAt, lastMessageAt',
            ExpressionAttributeNames: { '#t': 'type' },
            ScanIndexForward: false,
            Limit: 50,
          }));
          return (result.Items ?? []).map((item) => ({
            sessionId: item['sessionId'],
            type: item['type'],
            preview: item['preview'],
            startedAt: item['startedAt'],
            lastMessageAt: item['lastMessageAt'],
            legacy,
            displayLabel,
          }));
        })
      );
      // Merge and sort by lastMessageAt descending so the user sees the
      // most recently active session first regardless of type.
      const sessions = groups
        .flat()
        .sort((a, b) =>
          String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? ''))
        );
      return json(200, { sessions });
    } catch (err) {
      console.error('handleListHistory[all] error:', (err as Error).message);
      return json(500, { error: 'Failed to list history' });
    }
  }

  // ── Single-type list (sales | inbox | assistant) ────────────────
  const skPrefix = `CHAT_HISTORY#${type}#`;
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':uid': userId, ':prefix': skPrefix },
      // Return metadata only — no full messages list
      ProjectionExpression: 'sessionId, #t, preview, startedAt, lastMessageAt',
      ExpressionAttributeNames: { '#t': 'type' },
      ScanIndexForward: false, // newest first
      Limit: 50,
    }));
    const sessions = (result.Items ?? []).map((item) => ({
      sessionId: item['sessionId'],
      type: item['type'],
      preview: item['preview'],
      startedAt: item['startedAt'],
      lastMessageAt: item['lastMessageAt'],
    }));
    return json(200, { sessions });
  } catch (err) {
    console.error('handleListHistory error:', (err as Error).message);
    return json(500, { error: 'Failed to list history' });
  }
}

async function handleGetHistory(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!userId) return json(401, { error: 'Unauthorized' });
  const sessionId = event.pathParameters?.['sessionId'];
  if (!sessionId) return json(400, { error: 'sessionId is required' });
  const type = event.queryStringParameters?.['type'] ?? 'sales';
  const sk = `CHAT_HISTORY#${type}#${sessionId}`;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId, sk },
    }));
    if (!result.Item) return json(404, { error: 'Session not found' });
    return json(200, { session: result.Item });
  } catch (err) {
    console.error('handleGetHistory error:', (err as Error).message);
    return json(500, { error: 'Failed to get history' });
  }
}

async function handleSaveHistory(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!userId) return json(401, { error: 'Unauthorized' });
  if (!event.body) return json(400, { error: 'Body required' });
  let body: Partial<HistorySession>;
  try { body = JSON.parse(event.body) as Partial<HistorySession>; }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { sessionId, type, messages } = body;
  if (!sessionId || !type || !messages?.length) {
    return json(400, { error: 'sessionId, type, and messages are required' });
  }
  if (type !== 'sales' && type !== 'inbox' && type !== 'assistant') {
    return json(400, { error: 'type must be sales, inbox, or assistant' });
  }

  const now = new Date().toISOString();
  const firstUserMsg = messages.find((m) => m.role === 'user');
  const preview = firstUserMsg
    ? firstUserMsg.content.slice(0, 120) + (firstUserMsg.content.length > 120 ? '…' : '')
    : '(no messages)';

  const session: HistorySession & { userId: string; sk: string } = {
    userId,
    sk: `CHAT_HISTORY#${type}#${sessionId}`,
    sessionId,
    type,
    preview,
    messages,
    startedAt: body.startedAt ?? now,
    lastMessageAt: now,
    ttl: historyTtl(),
  };

  try {
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: session }));
    return json(200, { saved: true, sessionId });
  } catch (err) {
    console.error('handleSaveHistory error:', (err as Error).message);
    return json(500, { error: 'Failed to save history' });
  }
}

async function handleDeleteHistory(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!userId) return json(401, { error: 'Unauthorized' });
  const sessionId = event.pathParameters?.['sessionId'];
  if (!sessionId) return json(400, { error: 'sessionId is required' });
  const type = event.queryStringParameters?.['type'] ?? 'sales';
  const sk = `CHAT_HISTORY#${type}#${sessionId}`;
  try {
    await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { userId, sk } }));
    return json(200, { deleted: true });
  } catch (err) {
    console.error('handleDeleteHistory error:', (err as Error).message);
    return json(500, { error: 'Failed to delete history' });
  }
}

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const callerUserId = event.requestContext.authorizer.jwt.claims['sub'] as string | undefined;
  const route = event.routeKey;

  // ── History routes ────────────────────────────────────────────────
  if (route === 'GET /chat/history') {
    return handleListHistory(event, callerUserId);
  }
  if (route === 'GET /chat/history/{sessionId}') {
    return handleGetHistory(event, callerUserId);
  }
  if (route === 'POST /chat/history') {
    return handleSaveHistory(event, callerUserId);
  }
  if (route === 'DELETE /chat/history/{sessionId}') {
    return handleDeleteHistory(event, callerUserId);
  }

  // ── Chat route ────────────────────────────────────────────────────
  let body: { messages?: Array<{ role: string; content: string }> };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const rawMessages = body.messages ?? [];
  if (rawMessages.length === 0) return json(400, { error: 'messages array is required' });

  // Build Bedrock message array, stripping leading assistant messages
  const bedrockMessages: Message[] = rawMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: [{ text: m.content }] }));

  while (bedrockMessages.length > 0 && bedrockMessages[0]?.role === 'assistant') {
    bedrockMessages.shift();
  }
  if (bedrockMessages.length === 0) return json(400, { error: 'No valid user messages provided' });

  // ── Agentic tool-use loop ─────────────────────────────────────────
  // Max 5 tool call rounds to prevent runaway loops
  const MAX_ROUNDS = 5;
  let round = 0;
  // Collect attachment metadata from cache_read calls so the frontend
  // can render download chips alongside the assistant reply.
  const referencedAttachments: Array<{
    messageId: string;
    subject?: string;
    attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  }> = [];

  try {
    while (round < MAX_ROUNDS) {
      round++;

      const response = await bedrockClient.send(new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: buildSystemPrompt() }],
        messages: bedrockMessages,
        toolConfig: { tools: TOOLS },
        inferenceConfig: { maxTokens: 2048, temperature: 0.2 },
      }));

      const assistantContent = response.output?.message?.content ?? [];
      const stopReason = response.stopReason;

      // Add assistant turn to conversation history
      bedrockMessages.push({ role: 'assistant', content: assistantContent as ContentBlock[] });

      // If model is done, extract and return the text reply
      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        const textBlock = assistantContent.find(b => 'text' in b);
        const reply = textBlock && 'text' in textBlock ? textBlock.text : 'Sorry, I could not generate a response.';
        return json(200, {
          reply,
          // Include any attachment metadata collected during tool calls
          attachments: referencedAttachments.length > 0 ? referencedAttachments : undefined,
        });
      }

      // If model wants to use tools, execute them all and send results back
      if (stopReason === 'tool_use') {
        const toolUseBlocks = assistantContent.filter(b => 'toolUse' in b);
        if (toolUseBlocks.length === 0) break;

        const toolResults = (await Promise.all(
          toolUseBlocks.map(async (block) => {
            if (!('toolUse' in block) || !block.toolUse) {
              return { toolResult: { toolUseId: 'unknown', content: [{ text: 'Invalid tool call' }] } };
            }
            const { toolUseId, name, input } = block.toolUse;
            console.log(`Tool call: ${name}`, JSON.stringify(input));
            try {
              const result = await executeTool(name ?? '', (input ?? {}) as Record<string, unknown>, callerUserId, referencedAttachments);
              console.log(`Tool result: ${name} → ${result.slice(0, 200)}`);
              return {
                toolResult: {
                  toolUseId: toolUseId ?? '',
                  content: [{ text: result }],
                  status: 'success' as const,
                },
              };
            } catch (err) {
              console.error(`Tool error: ${name}`, (err as Error).message);
              return {
                toolResult: {
                  toolUseId: toolUseId ?? '',
                  content: [{ text: `Error: ${(err as Error).message}` }],
                  status: 'error' as const,
                },
              };
            }
          })
        )) as unknown as ToolResultContentBlock[];

        // Add tool results as a user turn
        bedrockMessages.push({ role: 'user', content: toolResults as ContentBlock[] });
        continue;
      }

      // Unexpected stop reason — break out
      break;
    }

    return json(200, { reply: 'I was unable to complete the request. Please try again.' });
  } catch (err) {
    console.error('Bedrock error:', (err as Error).message);
    return json(502, { error: 'Failed to get response from AI model' });
  }
};
