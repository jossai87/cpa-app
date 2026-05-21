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
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  cacheQuery,
  cacheRead,
  cacheVendorActivity,
  type CachedQueryArgs,
} from '../gmail-analysis/cache';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const MODEL_ID = process.env['BEDROCK_MODEL_ID'] ?? 'us.amazon.nova-pro-v1:0';

// ── Helpers ──────────────────────────────────────────────────────────

const STORE_TZ = 'America/Chicago';

function ctDateStr(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function todayStr(): string { return ctDateStr(); }
function daysAgo(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return ctDateStr(d);
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS: Tool[] = [
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
      description: 'Read full body of a cached email by id (and dateOnly for speed).',
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

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const today = todayStr();
  const currentYear = today.slice(0, 4);

  switch (name) {

    case 'get_sales_summary': {
      const from = (input['from_date'] as string) || daysAgo(30);
      const to = (input['to_date'] as string) || today;
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':uid': OWNER_USER_ID,
          ':from': `POS#DAILY#${from}`,
          ':to': `POS#DAILY#${to}`,
        },
      }));
      const items = result.Items ?? [];
      type Rollup = { date: string; count: number; totalAmount: number; totalDiscounts: number };
      let revenue = 0, tickets = 0, discounts = 0;
      const daily: Array<{ date: string; revenue: number; tickets: number }> = [];
      for (const item of items) {
        const r = item['rollup'] as Rollup | undefined;
        if (!r) continue;
        revenue += r.totalAmount ?? 0;
        tickets += r.count ?? 0;
        discounts += r.totalDiscounts ?? 0;
        daily.push({ date: r.date, revenue: round2(r.totalAmount), tickets: r.count });
      }
      daily.sort((a, b) => a.date.localeCompare(b.date));
      return JSON.stringify({
        from, to,
        totalRevenue: round2(revenue),
        totalTickets: tickets,
        totalDiscounts: round2(discounts),
        avgTicket: tickets > 0 ? round2(revenue / tickets) : 0,
        daysWithSales: daily.length,
        dailyBreakdown: daily,
      });
    }

    case 'get_returns_data': {
      const year = (input['year'] as string) === 'current' || !input['year'] ? currentYear : input['year'] as string;
      const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk } }));
      const returnRows = (result.Item?.['returnRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const data = returnRows
        .map(r => {
          const brand = String(r['item.custom@brand'] ?? 'Unknown');
          const grossSales = round2((r['source_sales.gross_sales'] as number) ?? 0);
          const grossReturns = round2(Math.abs((r['source_sales.gross_returns'] as number) ?? 0));
          const grossQtySold = (r['source_sales.gross_qty_sold'] as number) ?? 0;
          const grossQtyReturned = (r['source_sales.gross_qty_returned'] as number) ?? 0;
          const returnRate = grossSales > 0 ? round2((grossReturns / grossSales) * 100) : 0;
          return { brand, grossSales, grossReturns, grossQtySold, grossQtyReturned, returnRatePct: returnRate };
        })
        .filter(r => r.grossSales > 0 || r.grossReturns > 0)
        .sort((a, b) => b.grossReturns - a.grossReturns);
      const totalReturns = round2(data.reduce((s, r) => s + r.grossReturns, 0));
      const totalSales = round2(data.reduce((s, r) => s + r.grossSales, 0));
      return JSON.stringify({
        year,
        totalGrossReturns: totalReturns,
        totalGrossSales: totalSales,
        overallReturnRatePct: totalSales > 0 ? round2((totalReturns / totalSales) * 100) : 0,
        byBrand: data,
      });
    }

    case 'get_inventory': {
      const section = (input['section'] as string) || 'all';
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#INVENTORY#CATALOG' } }));
      const data = result.Item?.['data'] as Record<string, unknown> | undefined;
      if (!data) return JSON.stringify({ error: 'Inventory not synced yet' });
      const out: Record<string, unknown> = {};
      if (section === 'summary' || section === 'all') out['summary'] = data['summary'];
      if (section === 'low_stock' || section === 'all') out['lowStockItems'] = data['lowStockItems'];
      if (section === 'top_margin' || section === 'all') out['topMarginItems'] = (data['topMarginItems'] as unknown[])?.slice(0, 20);
      if (section === 'low_margin' || section === 'all') out['lowMarginItems'] = data['lowMarginItems'];
      if (section === 'by_department' || section === 'all') out['byDepartment'] = data['byDepartment'];
      out['cachedAt'] = result.Item?.['cachedAt'];
      return JSON.stringify(out);
    }

    case 'get_staff_performance': {
      const from = (input['from_date'] as string) || daysAgo(30);
      const to = (input['to_date'] as string) || today;
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':uid': OWNER_USER_ID,
          ':from': `POS#DAILY#${from}`,
          ':to': `POS#DAILY#${to}`,
        },
      }));
      type Rollup = { bySalesRep?: Record<string, number> };
      const repTotals: Record<string, { revenue: number; days: number }> = {};
      for (const item of result.Items ?? []) {
        const r = item['rollup'] as Rollup | undefined;
        if (!r?.bySalesRep) continue;
        for (const [rep, amt] of Object.entries(r.bySalesRep)) {
          if (!repTotals[rep]) repTotals[rep] = { revenue: 0, days: 0 };
          repTotals[rep]!.revenue += amt as number;
          repTotals[rep]!.days += 1;
        }
      }
      const staff = Object.entries(repTotals)
        .map(([name, v]) => ({ name, revenue: round2(v.revenue), activeDays: v.days, avgPerDay: v.days > 0 ? round2(v.revenue / v.days) : 0 }))
        .sort((a, b) => b.revenue - a.revenue);
      return JSON.stringify({ from, to, staff });
    }

    case 'get_brand_performance': {
      const year = (input['year'] as string) === 'current' || !input['year'] ? currentYear : input['year'] as string;
      const topN = (input['top_n'] as number) || 20;
      const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk } }));
      const brandRows = (result.Item?.['brandRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      // Merge case-insensitive duplicates
      const merged = new Map<string, { brand: string; netSales: number; netQty: number; transactions: number }>();
      for (const r of brandRows) {
        const raw = ((r['item.custom@brand'] as string | undefined) ?? '').trim();
        const key = raw.toUpperCase() || '__NULL__';
        let entry = merged.get(key);
        if (!entry) { entry = { brand: raw || '(no brand)', netSales: 0, netQty: 0, transactions: 0 }; merged.set(key, entry); }
        entry.netSales += (r['source_sales.net_sales'] as number) ?? 0;
        entry.netQty += (r['source_sales.net_qty_sold'] as number) ?? 0;
        entry.transactions += (r['source_sales.transaction_count'] as number) ?? 0;
      }
      const brands = Array.from(merged.values())
        .map(b => ({ ...b, netSales: round2(b.netSales) }))
        .sort((a, b) => b.netSales - a.netSales)
        .slice(0, topN);
      return JSON.stringify({ year, brands });
    }

    case 'get_purchasing': {
      const section = (input['section'] as string) || 'all';
      const [vendorsResult, ordersResult] = await Promise.all([
        docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#VENDORS' } })),
        docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#ORDERS' } })),
      ]);
      const out: Record<string, unknown> = {};
      if (section === 'vendors' || section === 'all') out['vendors'] = vendorsResult.Item?.['vendors'];
      if (section === 'vendor_rank' || section === 'all') out['vendorRank'] = vendorsResult.Item?.['vendorRank'];
      if (section === 'open_orders' || section === 'all') {
        out['openOrders'] = ordersResult.Item?.['orders'];
        out['totalOrdersAllTime'] = ordersResult.Item?.['totalOrders'];
      }
      return JSON.stringify(out);
    }

    case 'get_customer_insights': {
      const year = (input['year'] as string) === 'current' || !input['year'] ? currentYear : input['year'] as string;
      const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk } }));
      const customerRows = (result.Item?.['customerRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const totalCustomers = customerRows.filter(r => r['customer.public_id']).length;
      const repeatCustomers = customerRows.filter(r => ((r['source_sales.transaction_count'] as number) ?? 0) > 1).length;
      const newCustomers = totalCustomers - repeatCustomers;
      const repeatRevenue = round2(customerRows
        .filter(r => ((r['source_sales.transaction_count'] as number) ?? 0) > 1)
        .reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0));
      return JSON.stringify({
        year, totalCustomers, repeatCustomers, newCustomers,
        repeatRate: totalCustomers > 0 ? round2((repeatCustomers / totalCustomers) * 100) : 0,
        repeatRevenue,
      });
    }

    case 'get_payment_methods': {
      const from = (input['from_date'] as string) || daysAgo(30);
      const to = (input['to_date'] as string) || today;
      const [rollupsResult, ptResult] = await Promise.all([
        docClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':from': `POS#DAILY#${from}`, ':to': `POS#DAILY#${to}` },
        })),
        docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PAYMENT_TYPES#LIST' } })),
      ]);
      const ptList = (ptResult.Item?.['types'] as Array<{ id: number; name: string }> | undefined) ?? [];
      const ptMap: Record<string, string> = {};
      for (const p of ptList) ptMap[String(p.id)] = p.name;
      type Rollup = { byPaymentType?: Record<string, { count: number; amount: number }> };
      const totals: Record<string, { count: number; amount: number }> = {};
      for (const item of rollupsResult.Items ?? []) {
        const r = item['rollup'] as Rollup | undefined;
        if (!r?.byPaymentType) continue;
        for (const [id, v] of Object.entries(r.byPaymentType)) {
          if (!totals[id]) totals[id] = { count: 0, amount: 0 };
          totals[id]!.count += v.count;
          totals[id]!.amount += v.amount;
        }
      }
      const methods = Object.entries(totals)
        .map(([id, v]) => ({ name: ptMap[id] ?? `Type ${id}`, count: v.count, amount: round2(v.amount) }))
        .sort((a, b) => b.amount - a.amount);
      return JSON.stringify({ from, to, paymentMethods: methods });
    }

    case 'get_sync_status': {
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#SYNC#STATUS' } }));
      return JSON.stringify(result.Item ?? { status: 'never synced' });
    }

    case 'cache_query': {
      try {
        const result = await cacheQuery(input as CachedQueryArgs);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `cache_query failed: ${(err as Error).message}` });
      }
    }

    case 'cache_vendor_activity': {
      const vendor = String(input['vendor'] ?? '');
      if (!vendor) return JSON.stringify({ error: 'vendor is required' });
      const days = Math.min(Number(input['days']) || 90, 365);
      try {
        return JSON.stringify(await cacheVendorActivity(vendor, days));
      } catch (err) {
        return JSON.stringify({ error: `cache_vendor_activity failed: ${(err as Error).message}` });
      }
    }

    case 'cache_read': {
      const id = String(input['id'] ?? '');
      if (!id) return JSON.stringify({ error: 'id is required' });
      const dateOnly = String(input['dateOnly'] ?? '') || undefined;
      try {
        const m = await cacheRead(id, dateOnly);
        return JSON.stringify(m ?? { error: `Message ${id} not in cache` });
      } catch (err) {
        return JSON.stringify({ error: `cache_read failed: ${(err as Error).message}` });
      }
    }

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

Inbox-aware reasoning (use when a question would benefit from email context):
- You have a LOCAL CACHE of the owner's Gmail inbox (rolling ~6 month window) accessible via three tools: cache_query, cache_vendor_activity, cache_read.
- When a question is about a specific vendor or brand, prefer cache_vendor_activity(vendor, days) — gives last contact date, top senders, top subjects, recent message ids in one shot.
- For broader inbox digs use cache_query({ vendor, kind, since, until, from, text }). kind = invoice | vendor | customer | internal.
- Do NOT use Gmail tools for purely numeric POS questions (today's sales, top brands, etc.) — that's noise.
- Do NOT quote email bodies verbatim. Paraphrase, and cite the message id like "(msg 18a3f...)" so the owner can find the thread`.trim();
}

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
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
        return json(200, { reply });
      }

      // If model wants to use tools, execute them all and send results back
      if (stopReason === 'tool_use') {
        const toolUseBlocks = assistantContent.filter(b => 'toolUse' in b);
        if (toolUseBlocks.length === 0) break;

        const toolResults: ToolResultContentBlock[] = await Promise.all(
          toolUseBlocks.map(async (block) => {
            if (!('toolUse' in block) || !block.toolUse) {
              return { toolResult: { toolUseId: 'unknown', content: [{ text: 'Invalid tool call' }] } };
            }
            const { toolUseId, name, input } = block.toolUse;
            console.log(`Tool call: ${name}`, JSON.stringify(input));
            try {
              const result = await executeTool(name ?? '', (input ?? {}) as Record<string, unknown>);
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
        );

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
