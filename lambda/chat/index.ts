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

// ── Vendor contact directory (mirrors SalesRevenue.tsx) ──────────────
// Single source of truth for vendor phone, email, rep, and account info.
// The agent uses this via get_vendor_contacts before falling back to Gmail.

const VENDOR_CONTACTS: Record<string, {
  phone?: string; email?: string; website?: string;
  rep?: { name: string; phone?: string; email?: string; account?: string };
  aliases?: string[];
}> = {
  'BROOKS':           { phone: '1-800-227-6657', email: 'retailer@brooksrunning.com', website: 'https://www.brooksrunning.com', rep: { name: 'Jacob Brooks — Territory Mgr, North TX/OK', phone: '239-839-7971', email: 'Jacob.brooks@brooksrunning.com' } },
  'SAUCONY':          { phone: '1-800-282-6575', email: 'customerservice@saucony.com', website: 'https://www.saucony.com' },
  'DANSKO':           { phone: '1-800-326-7564', email: 'moreinfo@dansko.com', website: 'https://www.dansko.com' },
  'VIONIC':           { phone: '1-800-832-9255', email: 'info@vionicshoes.com', website: 'https://www.vionicshoes.com' },
  'AETREX':           { phone: '1-888-526-2739', email: 'help@aetrex.com', website: 'https://www.aetrex.com' },
  'DREW':             { phone: '1-800-837-3739', email: 'customerservice@drewshoe.com', website: 'https://www.drewshoe.com' },
  'FINN USA':         { phone: '1-877-353-6642', email: 'orders@finncomfortusa.net', website: 'https://www.finncomfortusa.net' },
  'MEPHISTO':         { phone: '1-615-771-5900', email: 'info@mephistousa.com', website: 'https://mephistousa.com' },
  'ROCKPORT':         { phone: '1-800-762-5767', email: 'consumercare@help.rockport.com', website: 'https://www.rockport.com' },
  'OLUKAI':           { phone: '1-877-789-5131', email: 'info@olukai.com', website: 'https://olukai.com' },
  'HAFLINGER COMFORT FOOTWEAR': { phone: '1-800-551-7556', email: 'help@haflinger.com', website: 'https://us.haflinger.com' },
  'WALDLAUFER':       { website: 'https://waldlauferfootwear.com' },
  'GIESSWEIN':        { phone: '+43-5337-6135-0', email: 'shop@giesswein.com', website: 'https://us.giesswein.com' },
  'SANITA':           { website: 'https://www.sanita.com' },
  'FEETURES':         { email: 'hello@feetures.com', website: 'https://feetures.com' },
  'CALERES':          { phone: '1-888-509-8200', email: 'retailerservices@caleres.com', website: 'https://www.caleres.com' },
  'P.W.MINOR':        { phone: '1-585-343-1500', email: 'info@pwminor.com', website: 'https://www.pwminor.com' },
  'PEDAG INTERNATIONAL': { email: 'info@pedag.com', website: 'https://pedagusa.com' },
  'EARTH BRAND SHOES': { website: 'https://www.earthbrands.com' },
  'KUMFS/ZIERA':      { website: 'https://www.zierausa.com' },
  'YALEET':           { phone: '516-465-6268', website: 'https://www.naot.com', aliases: ['NAOT'], rep: { name: 'Joey DeWitt — Sales Rep', phone: '817-975-3365' } },
  'AMERIBAG':         { phone: '1-800-AMERIBAG', website: 'https://www.ameribag.com' },
  'FIDELIO':          { phone: '414-778-2288', website: 'https://www.berkemann.com', aliases: ['RUBY LEATHER', 'FIDELIO (RUBY LEATHER)'] },
  'BERKEMANN':        { website: 'https://www.berkemann.com' },
  'JUSTIN BLAIR':     { phone: '800-566-0664', website: 'https://www.burtendistribution.com' },
  'SHU-RE-NU':        { email: 'tbogumill@shu-re-nu.com', rep: { name: 'Tammy Bogumill' } },
  'INSTRIDE':         { phone: '866-969-3338', website: 'https://www.xeleroshoes.com', aliases: ['XELERO'] },
  'THORLO':           { website: 'https://www.thorlo.com' },
  'HOKA':             { phone: '1-888-463-4652', website: 'https://www.hoka.com' },
  'APEX':             { phone: '800-252-2739', email: 'Lisa.fryberger@ohi.net', website: 'https://www.apexfoot.com', rep: { name: 'Lisa Fryberger', phone: '631-615-4176', account: '97378' } },
  'PEDORS':           { phone: '1-800-750-6729', website: 'https://www.pedors.com' },
  'PEDIFIX':          { phone: '1-800-424-5561', website: 'https://www.pedifix.com' },
};

/** Look up a vendor by name, case-insensitively, also checking aliases. */
function lookupVendor(name: string): { key: string; data: typeof VENDOR_CONTACTS[string] } | null {
  const upper = name.toUpperCase().trim();
  // Direct match
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (key.toUpperCase() === upper) return { key, data };
  }
  // Alias match
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (data.aliases?.some(a => a.toUpperCase() === upper)) return { key, data };
  }
  // Partial match (contains)
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (key.toUpperCase().includes(upper) || upper.includes(key.toUpperCase())) return { key, data };
  }
  return null;
}

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS: Tool[] = [
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

async function executeTool(name: string, input: Record<string, unknown>, callerUserId?: string): Promise<string> {
  const today = todayStr();
  const currentYear = today.slice(0, 4);

  switch (name) {

    case 'get_vendor_contacts': {
      const vendorName = input['vendor_name'] as string | undefined;
      if (vendorName && vendorName.trim()) {
        const match = lookupVendor(vendorName.trim());
        if (!match) {
          return JSON.stringify({
            found: false,
            searched: vendorName,
            message: `No contact info found for "${vendorName}" in the vendor directory. Try get_purchasing to see the full vendor list from Heartland.`,
          });
        }
        const { key, data } = match;
        return JSON.stringify({
          found: true,
          vendorName: key,
          aliases: data.aliases ?? [],
          phone: data.phone ?? null,
          email: data.email ?? null,
          website: data.website ?? null,
          rep: data.rep ? {
            name: data.rep.name,
            phone: data.rep.phone ?? null,
            email: data.rep.email ?? null,
            accountNumber: data.rep.account ?? null,
          } : null,
        });
      }
      // Return all vendors
      const all = Object.entries(VENDOR_CONTACTS).map(([key, data]) => ({
        vendorName: key,
        aliases: data.aliases ?? [],
        phone: data.phone ?? null,
        email: data.email ?? null,
        website: data.website ?? null,
        rep: data.rep ? {
          name: data.rep.name,
          phone: data.rep.phone ?? null,
          email: data.rep.email ?? null,
          accountNumber: data.rep.account ?? null,
        } : null,
      }));
      return JSON.stringify({ vendors: all, count: all.length });
    }

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

    case 'get_hourly_heatmap': {
      const from = (input['from_date'] as string) || daysAgo(30);
      const to = (input['to_date'] as string) || today;
      const dayFilter = (input['day_of_week'] as string | undefined)?.toLowerCase();
      const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':from': `POS#DAILY#${from}`, ':to': `POS#DAILY#${to}` },
      }));
      type Rollup = { date: string; byHour?: Record<string, number> };
      const hourTotals: Record<string, { revenue: number; days: number }> = {};
      let daysIncluded = 0;
      for (const item of result.Items ?? []) {
        const r = item['rollup'] as Rollup | undefined;
        if (!r?.byHour) continue;
        // Apply day-of-week filter if requested
        if (dayFilter) {
          const d = new Date(r.date + 'T12:00:00');
          const dayName = DAY_NAMES[d.getDay()];
          if (dayName !== dayFilter) continue;
        }
        daysIncluded++;
        for (const [hour, amt] of Object.entries(r.byHour)) {
          if (!hourTotals[hour]) hourTotals[hour] = { revenue: 0, days: 0 };
          hourTotals[hour]!.revenue += amt as number;
          hourTotals[hour]!.days += 1;
        }
      }
      const hours = Array.from({ length: 24 }, (_, h) => {
        const key = String(h).padStart(2, '0');
        const t = hourTotals[key] ?? { revenue: 0, days: 0 };
        const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
        return {
          hour: h, label,
          totalRevenue: round2(t.revenue),
          avgRevenue: t.days > 0 ? round2(t.revenue / t.days) : 0,
          daysActive: t.days,
        };
      }).filter(h => h.totalRevenue > 0);
      const peak = hours.reduce((best, h) => h.avgRevenue > best.avgRevenue ? h : best, hours[0] ?? { label: 'none', avgRevenue: 0 });
      return JSON.stringify({
        from, to,
        dayFilter: dayFilter ?? 'all days',
        daysIncluded,
        peakHour: peak,
        byHour: hours,
      });
    }

    case 'get_top_customers': {
      const from = (input['from_date'] as string) || daysAgo(30);
      const to = (input['to_date'] as string) || today;
      const topN = Math.min(Number(input['top_n']) || 15, 50);
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':from': `POS#DAILY#${from}`, ':to': `POS#DAILY#${to}` },
      }));
      type Rollup = { topCustomers?: Record<string, number> };
      const customerTotals: Record<string, { revenue: number; visits: number }> = {};
      for (const item of result.Items ?? []) {
        const r = item['rollup'] as Rollup | undefined;
        if (!r?.topCustomers) continue;
        for (const [name, amt] of Object.entries(r.topCustomers)) {
          if (!name || name === 'null') continue;
          if (!customerTotals[name]) customerTotals[name] = { revenue: 0, visits: 0 };
          customerTotals[name]!.revenue += amt as number;
          customerTotals[name]!.visits += 1;
        }
      }
      const customers = Object.entries(customerTotals)
        .map(([name, v]) => ({ name, revenue: round2(v.revenue), visits: v.visits, avgPerVisit: v.visits > 0 ? round2(v.revenue / v.visits) : 0 }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, topN);
      const totalRevenue = round2(customers.reduce((s, c) => s + c.revenue, 0));
      return JSON.stringify({ from, to, topCustomers: customers, totalRevenueFromNamed: totalRevenue });
    }

    case 'get_open_orders_detail': {
      const vendorFilter = ((input['vendor_name'] as string) ?? '').toLowerCase().trim();
      const minDays = Number(input['min_days_open']) || 0;
      const [ordersResult, vendorsResult] = await Promise.all([
        docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#ORDERS' } })),
        docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#VENDORS' } })),
      ]);
      type Order = { id: number; public_id?: string; status?: string; vendor_id?: number; vendorName?: string; total_qty?: number; total_cost?: number; total_open_qty?: number; created_at?: string };
      const orders = (ordersResult.Item?.['orders'] as Order[] | undefined) ?? [];
      const vendorRank = (vendorsResult.Item?.['vendorRank'] as Array<{ vendorId: number; vendorName: string }> | undefined) ?? [];
      const vendorNameMap: Record<number, string> = {};
      for (const v of vendorRank) vendorNameMap[v.vendorId] = v.vendorName;
      const now = Date.now();
      const enriched = orders
        .map(o => {
          const name = o.vendorName ?? vendorNameMap[o.vendor_id ?? -1] ?? `Vendor ${o.vendor_id}`;
          const created = o.created_at ? new Date(o.created_at) : null;
          const daysOpen = created ? Math.floor((now - created.getTime()) / 86400000) : null;
          return {
            poNumber: o.public_id ?? String(o.id),
            vendorName: name,
            status: o.status ?? 'unknown',
            createdAt: o.created_at ?? null,
            daysOpen,
            qtyOrdered: o.total_qty ?? 0,
            qtyOpen: o.total_open_qty ?? 0,
            qtyReceived: (o.total_qty ?? 0) - (o.total_open_qty ?? 0),
            totalCost: round2(o.total_cost ?? 0),
            aging: daysOpen === null ? 'unknown' : daysOpen <= 7 ? 'fresh' : daysOpen <= 30 ? 'normal' : daysOpen <= 60 ? 'aging' : 'overdue',
          };
        })
        .filter(o => !vendorFilter || o.vendorName.toLowerCase().includes(vendorFilter))
        .filter(o => minDays === 0 || (o.daysOpen !== null && o.daysOpen >= minDays))
        .sort((a, b) => (b.daysOpen ?? 0) - (a.daysOpen ?? 0));
      // Vendor-level summary
      const byVendor: Record<string, { orders: number; totalCost: number; totalOpenQty: number; oldestDays: number }> = {};
      for (const o of enriched) {
        if (!byVendor[o.vendorName]) byVendor[o.vendorName] = { orders: 0, totalCost: 0, totalOpenQty: 0, oldestDays: 0 };
        byVendor[o.vendorName]!.orders += 1;
        byVendor[o.vendorName]!.totalCost += o.totalCost;
        byVendor[o.vendorName]!.totalOpenQty += o.qtyOpen;
        byVendor[o.vendorName]!.oldestDays = Math.max(byVendor[o.vendorName]!.oldestDays, o.daysOpen ?? 0);
      }
      const vendorSummary = Object.entries(byVendor)
        .map(([name, v]) => ({ vendorName: name, openOrders: v.orders, totalCommittedCost: round2(v.totalCost), totalOpenUnits: v.totalOpenQty, oldestOrderDays: v.oldestDays }))
        .sort((a, b) => b.totalCommittedCost - a.totalCommittedCost);
      return JSON.stringify({
        filter: vendorFilter || 'all vendors',
        minDaysOpen: minDays,
        totalOpenOrders: enriched.length,
        totalCommittedCost: round2(enriched.reduce((s, o) => s + o.totalCost, 0)),
        vendorSummary,
        orders: enriched,
      });
    }

    case 'get_historical_comparison': {
      const currentYearNum = parseInt(currentYear, 10);
      const requestedYears = (input['years'] as string[] | undefined) ?? [String(currentYearNum - 1), currentYear];
      // Cap at 4 years to avoid huge payloads
      const yearsToFetch = requestedYears.slice(0, 4);
      const results = await Promise.all(
        yearsToFetch.map(async yr => {
          const sk = yr === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${yr}`;
          const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk } }));
          if (!r.Item) return { year: yr, available: false };
          const brandRows = (r.Item['brandRows'] as Array<Record<string, unknown>> | undefined) ?? [];
          const totalsRows = (r.Item['totalsRows'] as Array<Record<string, unknown>> | undefined) ?? [];
          const netSales = totalsRows.length > 0
            ? round2(totalsRows.reduce((s, t) => s + ((t['source_sales.net_sales'] as number) ?? 0), 0))
            : round2(brandRows.reduce((s, b) => s + ((b['source_sales.net_sales'] as number) ?? 0), 0));
          const transactions = totalsRows.length > 0
            ? totalsRows.reduce((s, t) => s + ((t['source_sales.transaction_count'] as number) ?? 0), 0)
            : brandRows.reduce((s, b) => s + ((b['source_sales.transaction_count'] as number) ?? 0), 0);
          // Top 5 brands for context
          const merged = new Map<string, number>();
          for (const b of brandRows) {
            const brand = ((b['item.custom@brand'] as string | undefined) ?? '').trim().toUpperCase() || '__NULL__';
            merged.set(brand, (merged.get(brand) ?? 0) + ((b['source_sales.net_sales'] as number) ?? 0));
          }
          const topBrands = Array.from(merged.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([brand, sales]) => ({ brand, netSales: round2(sales) }));
          return {
            year: yr,
            available: true,
            netSales,
            transactions,
            avgTicket: transactions > 0 ? round2(netSales / transactions) : 0,
            fromDate: r.Item['fromDate'] ?? `${yr}-01-01`,
            toDate: r.Item['toDate'] ?? `${yr}-12-31`,
            topBrands,
            cachedAt: r.Item['cachedAt'],
          };
        })
      );
      // Compute YoY change between consecutive years
      const comparisons: Array<{ from: string; to: string; salesChangePct: number; salesChangeDollar: number }> = [];
      for (let i = 0; i < results.length - 1; i++) {
        const a = results[i]!, b = results[i + 1]!;
        if (a.available && b.available && typeof a.netSales === 'number' && typeof b.netSales === 'number') {
          const diff = b.netSales - a.netSales;
          comparisons.push({
            from: a.year, to: b.year,
            salesChangeDollar: round2(diff),
            salesChangePct: a.netSales > 0 ? round2((diff / a.netSales) * 100) : 0,
          });
        }
      }
      return JSON.stringify({ years: results, yearOverYearChanges: comparisons });
    }

    case 'get_orthotics_commission': {
      const period = (input['period'] as string) || 'ytd';
      const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#REPORTING#ORTHOTICS' } }));
      if (!result.Item) return JSON.stringify({ error: 'Orthotics data not synced yet. Click Sync Now on the Staff tab.' });
      type ORow = Record<string, unknown>;
      const rows = (result.Item['orthoticsRepRows'] as ORow[] | undefined) ?? [];
      const ORTHOTICS_PATTERN = /orthotic/i;
      const TIER1_MAX = 10, TIER1_RATE = 10, TIER2_RATE = 15;
      const repUnits: Record<string, number> = {};
      const hasDept = rows.some(r => r['item.department'] != null);
      for (const r of rows) {
        if (hasDept && !ORTHOTICS_PATTERN.test(String(r['item.department'] ?? ''))) continue;
        const rep = String(r['user.name'] ?? r['sales_rep'] ?? 'Unassigned').trim() || 'Unassigned';
        const qty = (r['source_sales.net_qty_sold'] as number) ?? 0;
        if (qty > 0) repUnits[rep] = (repUnits[rep] ?? 0) + qty;
      }
      const reps = Object.entries(repUnits).map(([name, units]) => {
        const tier1 = Math.min(units, TIER1_MAX);
        const tier2 = Math.max(0, units - TIER1_MAX);
        const commission = tier1 * TIER1_RATE + tier2 * TIER2_RATE;
        return { name, units, tier1Units: tier1, tier2Units: tier2, commissionOwed: commission };
      }).sort((a, b) => b.units - a.units);
      const totalCommission = reps.reduce((s, r) => s + r.commissionOwed, 0);
      const depts = [...new Set(rows.filter(r => ORTHOTICS_PATTERN.test(String(r['item.department'] ?? ''))).map(r => String(r['item.department'] ?? '')))];
      return JSON.stringify({
        period,
        commissionRules: `$${TIER1_RATE}/unit for units 1-${TIER1_MAX}, $${TIER2_RATE}/unit for unit ${TIER1_MAX + 1}+`,
        orthoticsDepartments: depts,
        departmentFilterApplied: hasDept,
        reps,
        totalCommissionOwed: totalCommission,
        cachedAt: result.Item['cachedAt'],
      });
    }

    case 'get_tax_summary': {
      // Tax sessions are stored under the authenticated user's own sub, not OWNER_USER_ID
      const taxUserId = callerUserId ?? OWNER_USER_ID;
      const taxYearFilter = input['tax_year'] as string | undefined;
      // Query all tax sessions for this user, sorted by most recent
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':uid': taxUserId, ':prefix': 'TAX#' },
        ScanIndexForward: false, // newest first
        Limit: 10,
      }));
      const sessions = (result.Items ?? []).filter(item => {
        if (!taxYearFilter) return true;
        return String(item['taxYear'] ?? '') === taxYearFilter;
      });
      if (sessions.length === 0) {
        return JSON.stringify({ error: taxYearFilter ? `No tax session found for ${taxYearFilter}` : 'No tax sessions found. Run a tax analysis first.' });
      }
      const latest = sessions[0]!;
      const inputData = latest['inputData'] as Record<string, unknown> | undefined;
      const result2 = latest['result'] as Record<string, unknown> | undefined;
      return JSON.stringify({
        sessionId: latest['sessionId'],
        taxYear: latest['taxYear'],
        entityType: latest['entityType'],
        createdAt: latest['createdAt'],
        status: latest['status'],
        formInputs: inputData ? {
          totalRevenue: inputData['totalRevenue'],
          cogs: inputData['cogs'],
          totalOperatingExpenses: inputData['totalOperatingExpenses'],
          rentLeasePayments: inputData['rentLeasePayments'],
          totalEmployeeWages: inputData['totalEmployeeWages'],
          royaltyFees: inputData['royaltyFees'],
          adFundContributions: inputData['adFundContributions'],
          businessInsurancePremiums: inputData['businessInsurancePremiums'],
          loanInterestPaid: inputData['loanInterestPaid'],
          salesTaxCollected: inputData['salesTaxCollected'],
          ownerHealthInsurancePremiums: inputData['ownerHealthInsurancePremiums'],
          hasEmployees: inputData['hasEmployees'],
          employeeCount: inputData['employeeCount'],
          isFranchise: inputData['isFranchise'],
        } : null,
        estimates: result2 ? {
          estimatedFederalTaxableIncome: result2['estimatedFederalTaxableIncome'],
          estimatedFederalTaxLiability: result2['estimatedFederalTaxLiability'],
          estimatedSelfEmploymentTax: result2['estimatedSelfEmploymentTax'],
          estimatedTexasFranchiseTax: result2['estimatedTexasFranchiseTax'],
          qbiDeduction: result2['qbiDeduction'],
          estimatedQuarterlyPayments: result2['estimatedQuarterlyPayments'],
          keyDeductions: result2['keyDeductions'],
          flaggedForCPAReview: result2['flaggedForCPAReview'],
          formsToFile: result2['formsToFile'],
          ownerSummary: result2['ownerSummary'],
        } : null,
      });
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
- Do NOT quote email bodies verbatim. Paraphrase, and cite the message id like "(msg 18a3f...)" so the owner can find the thread`.trim();
}

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const callerUserId = event.requestContext.authorizer.jwt.claims['sub'] as string | undefined;
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

        const toolResults = (await Promise.all(
          toolUseBlocks.map(async (block) => {
            if (!('toolUse' in block) || !block.toolUse) {
              return { toolResult: { toolUseId: 'unknown', content: [{ text: 'Invalid tool call' }] } };
            }
            const { toolUseId, name, input } = block.toolUse;
            console.log(`Tool call: ${name}`, JSON.stringify(input));
            try {
              const result = await executeTool(name ?? '', (input ?? {}) as Record<string, unknown>, callerUserId);
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
