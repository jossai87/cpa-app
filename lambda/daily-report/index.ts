/**
 * Foot Solutions daily report Lambda.
 *
 * Triggered by EventBridge Scheduler at 22:00 America/Chicago daily.
 * Pulls today's sales + comparison baselines from DynamoDB, calls Bedrock
 * Claude Sonnet 4.5 with rich context (sales data + curated geographic
 * intelligence + business strategy), generates a tight briefing, and sends
 * via SES to flowermound@footsolutions.com.
 *
 * The model is given tools to fetch additional data on demand:
 *   - get_sales_for_date    — daily rollup for any date
 *   - get_top_brands_today  — what moved today (with margins)
 *   - get_low_stock_urgent  — items at <=1 unit
 *   - get_local_events      — curated nearby events with addresses + dates
 *
 * After sending, the email is persisted to DynamoDB at sk=EMAIL#YYYY-MM-DD
 * so it can be displayed in the dashboard email feed.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { searchEmails, getMessage, summarizeRecentVendorMail } from '../gmail/client';
import {
  cacheQuery,
  cacheRead,
  cacheVendorActivity,
  type CachedQueryArgs,
} from '../gmail-analysis/cache';
import { tavilySearch } from '../shared/tavily';
import { kbSemanticSearch as vectorKbSearch } from '../shared/vectorIndex';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const sesClient = new SESv2Client({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const MODEL_ID = process.env['BEDROCK_MODEL_ID'] ?? 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
const FROM_ADDRESS = process.env['FROM_ADDRESS'] ?? 'notifications@fsmanagementsystem.com';
const TO_ADDRESS = process.env['TO_ADDRESS'] ?? 'flowermound@footsolutions.com';

const STORE_TZ = 'America/Chicago';

// Store closed Sun (0) and Mon (1). Email only sends Tue–Sat.
const STORE_CLOSED_DAYS_OF_WEEK = new Set<number>([0, 1]);

function ctDateStr(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function todayStr(): string { return ctDateStr(); }
function ctDayOfWeek(d = new Date()): number {
  // Returns 0–6 (Sun–Sat) in Central Time.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: STORE_TZ, weekday: 'short' }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts] ?? new Date().getDay();
}
function daysAgo(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return ctDateStr(d);
}
function round2(n: number) { return Math.round(n * 100) / 100; }

// ── Curated geographic + market intelligence ──────────────────────────
//
// Static knowledge base baked into the system prompt so v1 has zero
// external API cost. When you wire up Tavily/Brave later, `get_local_events`
// can be swapped for a live web search.

const LOCAL_INTELLIGENCE = `
=== STORE & MARKET CONTEXT ===
Store: Foot Solutions Flower Mound — 2701 Cross Timbers Rd area, Flower Mound TX 75028
Status: Recently acquired by new owner. Currently in declining sales state. Goal: 7-9× growth in 12 months.
Specialty: Custom orthotics ($400-500), orthopedic shoes, accessories, gait analysis.
Hours: Open Tue–Sat. Closed Sun & Mon (do NOT suggest events on Sun or Mon).

=== DENTON COUNTY DEMOGRAPHICS ===
- Population: 906,422 (2020 census), 7th most populous county in TX, fast-growing
- Senior population (65+) is one of fastest-growing demographic groups
- Adjacent: Lewisville, Highland Village, Argyle, Denton, Coppell, Grapevine
- High household incomes, strong disposable spending power

=== KEY VENUES (verified addresses + phones) ===

1. Flower Mound Senior Center
   Address: 2701 W Windsor Dr, Flower Mound TX 75028
   Phone: 972-874-6110 (courtesy desk + general info)
   Email: director@flseniorcenter.org
   Programs: "Seniors In Motion" daily fitness/dance/art classes, lunches, games.
   $10/yr resident, $20/yr non-resident.
   → Best fit: monthly demo days, fall-prevention seminars, fitting clinics.

2. Texas Health Presbyterian Hospital Flower Mound
   Address: 4400 Long Prairie Rd, Flower Mound TX 75028
   Volunteer/Community Outreach: call main 972-887-2900, ask for Volunteer Services
   Texas Health Resources general volunteer line: 1-866-411-9358
   → Best fit: nurse/staff bulk fittings, Wellness Wednesday partnerships.
   Designated Bariatric Surgery Center of Excellence — bariatric patients are
   prime orthopedic candidates due to weight-related foot issues.

3. Texas Health Presbyterian Hospital Denton
   Address: 3000 N I-35, Denton TX 76201
   Diabetes & wound care center — high-value referrals for diabetic shoes.

4. Medical City Lewisville
   Address: 500 W Main St, Lewisville TX 75057
   Phone: 972-420-1000

5. Flower Mound Chamber of Commerce
   Phone: 972-539-0500
   Web: flowermoundchamber.com
   → Best fit: networking mixers, ribbon cuttings, B2B introductions.

6. Flower Mound Public Library
   Address: 3030 Broadmoor Ln, Flower Mound TX 75028
   Phone: 972-874-6200
   → Best fit: free community event venue, foot health seminars.

7. Flower Mound Women in Business (FMWIB)
   Contact: Amanda Bennett
   Phone: 612-220-1378
   Address: 2221 Justin Rd Suite 119-101, Flower Mound TX 75028
   → Best fit: women's networking — high-margin customer demographic.

8. Flower Mound Pharmacy & Herbal Alternatives
   Contact: Dennis W. Song, RPh
   Phone: 972-355-4614
   Address: 1001 Cross Timbers Rd, Suite 1170, Flower Mound TX 75028
   → Best fit: cross-referral partner. Diabetics filling prescriptions need
   diabetic shoes. Just down the road from the store.

9. Flower Mound Presbyterian Church
   Address: 1501 Flower Mound Road, Flower Mound TX 75028
   Phone: 972-539-7184
   → Best fit: senior fellowship groups, health fair sponsorships.

10. Lewisville ISD (LISD) high schools — Flower Mound HS, Marcus HS
    Phone: 469-713-5192 (Flower Mound HS)
    → Best fit: athletic departments (coaches stand all day), wellness fairs.

11. UNT (University of North Texas), Denton
    Address: 1155 Union Cir, Denton TX 76203
    → Best fit: faculty, athletic programs, runner clubs (Brooks/Hoka).

=== TARGET MARKET PILLARS (high-value customer segments) ===
1. Hospitals/clinics: nurses, doctors, techs on 12-hour shifts
2. Restaurants: servers, line cooks, bartenders (Highland Village restaurant district)
3. Schools: teachers, coaches, school nurses (LISD, Argyle ISD)
4. Senior centers + senior living facilities
5. Churches with elderly congregations
6. Manufacturing/warehouse: Amazon DFT5/DFT6, FedEx in Lewisville/Coppell
7. Podiatrists: highest-margin recurring referrals (custom orthotics)

=== RECURRING LOCAL EVENTS (typical patterns) ===
- Flower Mound Senior Center Health Fair (annual fall)
- Senior Center monthly bingo + craft fairs (Tuesdays/Thursdays typical)
- Flower Mound Farmers Market (Saturdays seasonal, Town Hall Plaza)
- Heritage Days (Sept) — town festival
- Memorial Day Ceremony (May, Flower Mound)
- Denton Arts & Jazz Festival (April)
- DFW Senior Expos — multiple per year, sponsor opportunity
- Chamber Awards & networking mixers (monthly)

=== PRODUCT / MARGIN INTELLIGENCE ===
Custom orthotics: $400-500 retail, highest margin in store
Brooks/Hoka: athletic running, mid-margin, fast-mover, attracts younger customers
Aetrex: orthopedic comfort, ~50% margin, senior favorite
Dansko/Sanita: clogs, restaurant/medical staff favorite
Drew/PW Minor: extra-wide diabetic footwear, hospital referral driven
Brand-new accessories: high-margin, low-friction add-on at checkout

=== STRATEGIC PILLARS ===
1. INVENTORY VELOCITY — turn slow-movers into cash via markdowns
2. EVENT-BASED MARKETING — be where the foot pain is
3. B2B PARTNERSHIPS — bulk staff fittings at hospitals/schools/restaurants
4. PODIATRIST REFERRALS — recurring high-margin custom orthotic pipeline
5. LOCAL VISIBILITY — Google Business Profile, reviews, sponsorships
`;

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'get_sales_for_date',
      description: 'Get revenue, ticket count, discounts, top sales rep for a specific date. Use to compare today vs yesterday, vs same day last year, etc.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { date: { type: 'string', description: 'YYYY-MM-DD in Central Time' } },
          required: ['date'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_top_brands_today',
      description: 'Get the brands that sold today with margins, useful for spotting which brand to push or markdown.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Top N brands (default 5)' } },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_low_stock_urgent',
      description: 'Get items at 1 or fewer units on hand — these need immediate reorder or could be lost sales.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Top N items (default 10)' } },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_recent_trend',
      description: 'Get sales trend for the last N days to detect momentum (gaining/declining/flat).',
      inputSchema: {
        json: {
          type: 'object',
          properties: { days: { type: 'number', description: 'Number of days (default 7)' } },
          required: [],
        },
      },
    },
  },
  // ── Memory tools — give the model a persistent opportunity ledger ──
  {
    toolSpec: {
      name: 'get_pending_opportunities',
      description: 'Read the opportunity ledger — strategic items the AI is tracking across emails (events to attend, leads to follow up, low-stock to reorder, partnership pitches in progress, etc.). Returns each item with its priority, status, mention count, and last-mentioned date so you can decide whether to surface it again.',
      inputSchema: {
        json: { type: 'object', properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: 'record_opportunity',
      description: 'Add a new strategic opportunity to the ledger. Use this when you discover something worth tracking across multiple emails — like an upcoming event, a brand at urgent low-stock, a partnership lead, etc. The owner sees this in upcoming briefings.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable kebab-case ID (e.g. senior-center-bingo-may-25). Use the same ID across days for the same opportunity.' },
            title: { type: 'string', description: 'Short title (e.g. "Senior Center bingo demo opportunity")' },
            category: { type: 'string', enum: ['event', 'reorder', 'partnership', 'inventory', 'staff', 'other'], description: 'Type of opportunity' },
            priority: { type: 'number', description: 'Importance 1-10 (10 = must mention every day until done, 5 = mention every 2-3 days, 2 = mention once)' },
            details: { type: 'string', description: 'Full context: who/where/when/contact phone' },
            dueDate: { type: 'string', description: 'YYYY-MM-DD if time-sensitive (e.g. event date)' },
          },
          required: ['id', 'title', 'category', 'priority', 'details'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'update_opportunity',
      description: 'Mark an opportunity as mentioned in today\'s email (so we can space repeats by priority) OR update its details/priority based on new information.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The opportunity ID' },
            mentionedToday: { type: 'boolean', description: 'Set true if this was included in today\'s email' },
            priority: { type: 'number', description: 'New priority 1-10 (optional)' },
            details: { type: 'string', description: 'Updated details (optional)' },
            dueDate: { type: 'string', description: 'Updated due date YYYY-MM-DD (optional)' },
          },
          required: ['id'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'mark_opportunity_done',
      description: 'Remove an opportunity from the active ledger when it\'s been completed, attended, or expired. Past events should be marked done the day after.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The opportunity ID' },
            outcome: { type: 'string', description: 'Brief outcome note (e.g. "attended, 3 leads")' },
          },
          required: ['id'],
        },
      },
    },
  },
  // ── Gmail tools — read recent vendor + key-people emails ────────────
  {
    toolSpec: {
      name: 'scan_recent_vendor_emails',
      description: 'Quickly scan the last 14 days of inbox for vendor brand mentions (Brooks, Dansko, Aetrex, etc.) plus key people (Roland, Janell). Returns up to 15 thread summaries with sender, subject, date, and snippet. Use this to surface vendor follow-ups, event invitations, or relationship context the owner might have missed.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { days: { type: 'number', description: 'How many days back to scan (default 14, max 30)' } },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'search_inbox',
      description: 'Search the inbox using Gmail query syntax (e.g. "from:brooksrunning.com newer_than:7d", "subject:invoice", "from:roland"). Returns matching message IDs you can pass to read_email.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Gmail search query — supports from:, to:, subject:, has:attachment, newer_than:Nd, etc.' },
            max: { type: 'number', description: 'Max results (default 10, hard cap 30)' },
          },
          required: ['query'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'read_email',
      description: 'Fetch the full headers + plaintext body of one email by ID (from search_inbox or scan_recent_vendor_emails). Use this when you need the actual content — pricing, dates, names — not just the snippet.',
      inputSchema: {
        json: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Gmail message ID' } },
          required: ['id'],
        },
      },
    },
  },
  // ── Cache-backed Gmail tools (faster than live Gmail) ────────────
  {
    toolSpec: {
      name: 'cache_query',
      description: "Query the local Gmail cache (rolling ~6 month window). Use kind=corporate / franchise / vendor / customer / invoice with since/until to scope. Faster than live Gmail. Use this BEFORE search_inbox.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: { type: 'string', description: 'Vendor brand (Brooks, Dansko, etc.)' },
            kind: {
              type: 'string',
              enum: ['invoice', 'vendor', 'customer', 'corporate', 'franchise', 'internal'],
            },
            since: { type: 'string', description: 'YYYY-MM-DD inclusive' },
            until: { type: 'string', description: 'YYYY-MM-DD inclusive' },
            from: { type: 'string', description: 'From-header substring' },
            text: { type: 'string', description: 'Subject/snippet substring' },
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
      description: "Quickly summarize a vendor's email activity over the last N days: message count, last contact date, top senders, top subjects. Use to answer 'how active is Brooks' or 'when did Aetrex last reach out'.",
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
      description: 'Read full body of a cached email. Provide dateOnly for fastest path.',
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
  // ── Web search (Tavily) ──────────────────────────────────────────
  {
    toolSpec: {
      name: 'web_search',
      description: "Tavily news search. Use SPARINGLY (max 2 calls per email) to verify a vendor announcement or local event before recommending it. Examples: 'Foot Solutions corporate news 2026', 'Brooks running launch this week', 'Flower Mound Senior Center events May 2026'.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            days: { type: 'number', description: 'Last N days (default 7).' },
            maxResults: { type: 'number' },
          },
          required: ['query'],
        },
      },
    },
  },
  // ── Semantic search over the inbox (Cohere embeddings + S3 Vectors) ──
  {
    toolSpec: {
      name: 'kb_semantic_search',
      description:
        "Semantic / fuzzy search over the FULL TEXT of cached Gmail messages — use when the question is conceptual ('emails about pricing concerns', 'anyone hinting at a delayed shipment', 'complaints about fit') and exact-match cache_query (vendor / from / kind) won't surface it. Returns up to top_k message metadata + a body preview, ranked by relevance. Cheaper than read_email and broader than cache_query. Follow up with cache_read for full content if needed.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language search query.' },
            top_k: { type: 'number', description: 'Default 6, max 15.' },
          },
          required: ['query'],
        },
      },
    },
  },
];

// ── Tool execution ──────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const today = todayStr();

  switch (name) {
    case 'get_sales_for_date': {
      const date = (input['date'] as string) || today;
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: `POS#DAILY#${date}` },
      }));
      const r = result.Item?.['rollup'] as { count: number; totalAmount: number; totalDiscounts: number; bySalesRep: Record<string, number> } | undefined;
      if (!r) return JSON.stringify({ date, hasData: false });
      const topRep = Object.entries(r.bySalesRep ?? {}).sort((a, b) => b[1] - a[1])[0];
      return JSON.stringify({
        date, hasData: true,
        revenue: round2(r.totalAmount),
        tickets: r.count,
        discounts: round2(r.totalDiscounts ?? 0),
        avgTicket: r.count > 0 ? round2(r.totalAmount / r.count) : 0,
        topRep: topRep ? { name: topRep[0], amount: round2(topRep[1]) } : null,
      });
    }

    case 'get_top_brands_today': {
      const limit = (input['limit'] as number) || 5;
      // Brand data is YTD from reporting analyzer — best proxy for "moving"
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: 'POS#REPORTING#SALES' },
      }));
      const brandRows = (result.Item?.['brandRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const top = [...brandRows]
        .sort((a, b) => ((b['source_sales.net_sales'] as number) ?? 0) - ((a['source_sales.net_sales'] as number) ?? 0))
        .slice(0, limit)
        .map((r) => ({
          brand: r['item.custom@brand'] ?? 'Unknown',
          netSalesYTD: round2((r['source_sales.net_sales'] as number) ?? 0),
          unitsYTD: (r['source_sales.net_qty_sold'] as number) ?? 0,
        }));
      return JSON.stringify({ note: 'YTD net sales (proxy for momentum)', topBrands: top });
    }

    case 'get_low_stock_urgent': {
      const limit = (input['limit'] as number) || 10;
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: 'POS#INVENTORY#CATALOG' },
      }));
      const items = ((result.Item?.['data'] as Record<string, unknown> | undefined)?.['lowStockItems'] as Array<{ description: string; brand: string; qty_on_hand: number; price: number }> | undefined) ?? [];
      const urgent = items.filter((i) => i.qty_on_hand <= 1).slice(0, limit);
      return JSON.stringify({ urgentItems: urgent, totalLowStock: items.length });
    }

    case 'get_recent_trend': {
      const days = (input['days'] as number) || 7;
      const from = daysAgo(days);
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':from': `POS#DAILY#${from}`, ':to': `POS#DAILY#${today}` },
      }));
      type Rollup = { date: string; totalAmount: number; count: number };
      const trend = (result.Items ?? []).map((it) => {
        const r = it['rollup'] as Rollup | undefined;
        return r ? { date: r.date, revenue: round2(r.totalAmount), tickets: r.count } : null;
      }).filter(Boolean);
      const total = (trend as { revenue: number; tickets: number }[]).reduce((s, d) => s + d.revenue, 0);
      const avg = trend.length > 0 ? round2(total / trend.length) : 0;
      return JSON.stringify({ days, dailyAvg: avg, totalRevenue: round2(total), trend });
    }

    // ── Opportunity ledger (memory across daily emails) ──────────────
    case 'get_pending_opportunities': {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':prefix': 'OPP#' },
      }));
      const opportunities = (result.Items ?? [])
        .filter((it) => it['status'] !== 'done')
        .map((it) => ({
          id: it['id'],
          title: it['title'],
          category: it['category'],
          priority: it['priority'],
          details: it['details'],
          dueDate: it['dueDate'] ?? null,
          mentionCount: it['mentionCount'] ?? 0,
          lastMentioned: it['lastMentioned'] ?? null,
          daysSinceLastMention: it['lastMentioned']
            ? Math.floor((Date.now() - new Date(it['lastMentioned'] as string).getTime()) / 86_400_000)
            : null,
          createdAt: it['createdAt'],
        }))
        .sort((a, b) => (b.priority as number) - (a.priority as number));
      return JSON.stringify({
        count: opportunities.length,
        opportunities,
        guidance: 'Priority 8-10: mention every email until done. Priority 5-7: mention every 2-3 emails. Priority 2-4: mention once unless updated.',
      });
    }

    case 'record_opportunity': {
      const id = input['id'] as string;
      if (!id || !/^[a-z0-9-]+$/.test(id)) {
        return JSON.stringify({ error: 'id must be kebab-case (lowercase letters, digits, hyphens)' });
      }
      // Don't overwrite mention history if the opportunity already exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: `OPP#${id}` },
      }));
      const prev = existing.Item ?? {};
      const now = new Date().toISOString();
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: OWNER_USER_ID,
          sk: `OPP#${id}`,
          id,
          title: input['title'],
          category: input['category'],
          priority: input['priority'],
          details: input['details'],
          dueDate: input['dueDate'] ?? prev['dueDate'] ?? null,
          status: 'open',
          mentionCount: prev['mentionCount'] ?? 0,
          lastMentioned: prev['lastMentioned'] ?? null,
          createdAt: prev['createdAt'] ?? now,
          updatedAt: now,
        },
      }));
      return JSON.stringify({ ok: true, id, action: prev['createdAt'] ? 'updated' : 'created' });
    }

    case 'update_opportunity': {
      const id = input['id'] as string;
      if (!id) return JSON.stringify({ error: 'id is required' });
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: `OPP#${id}` },
      }));
      if (!existing.Item) return JSON.stringify({ error: `Opportunity ${id} not found` });
      const now = new Date().toISOString();
      const next: Record<string, unknown> = { ...existing.Item, updatedAt: now };
      if (input['mentionedToday']) {
        next['mentionCount'] = ((existing.Item['mentionCount'] as number) ?? 0) + 1;
        next['lastMentioned'] = now;
      }
      if (input['priority'] !== undefined) next['priority'] = input['priority'];
      if (input['details'] !== undefined) next['details'] = input['details'];
      if (input['dueDate'] !== undefined) next['dueDate'] = input['dueDate'];
      await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: next }));
      return JSON.stringify({ ok: true, id, mentionCount: next['mentionCount'] });
    }

    case 'mark_opportunity_done': {
      const id = input['id'] as string;
      if (!id) return JSON.stringify({ error: 'id is required' });
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: `OPP#${id}` },
      }));
      if (!existing.Item) return JSON.stringify({ error: `Opportunity ${id} not found` });
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...existing.Item,
          status: 'done',
          outcome: input['outcome'] ?? null,
          completedAt: new Date().toISOString(),
        },
      }));
      return JSON.stringify({ ok: true, id, status: 'done' });
    }

    // ── Gmail tools ──────────────────────────────────────────────────
    case 'scan_recent_vendor_emails': {
      const days = Math.min((input['days'] as number) || 14, 30);
      try {
        const summary = await summarizeRecentVendorMail(days);
        return JSON.stringify(summary);
      } catch (err) {
        return JSON.stringify({ error: `Gmail scan failed: ${(err as Error).message}` });
      }
    }

    case 'search_inbox': {
      const query = input['query'] as string;
      const max = Math.min((input['max'] as number) || 10, 30);
      if (!query) return JSON.stringify({ error: 'query is required' });
      try {
        const matches = await searchEmails(query, max);
        return JSON.stringify({ query, count: matches.length, messages: matches });
      } catch (err) {
        return JSON.stringify({ error: `Gmail search failed: ${(err as Error).message}` });
      }
    }

    case 'read_email': {
      const id = input['id'] as string;
      if (!id) return JSON.stringify({ error: 'id is required' });
      try {
        const msg = await getMessage(id);
        return JSON.stringify(msg);
      } catch (err) {
        return JSON.stringify({ error: `Gmail read failed: ${(err as Error).message}` });
      }
    }

    case 'cache_query': {
      try {
        return JSON.stringify(await cacheQuery(input as CachedQueryArgs));
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

    case 'web_search': {
      const query = String(input['query'] ?? '');
      if (!query) return JSON.stringify({ error: 'query is required' });
      try {
        return JSON.stringify(
          await tavilySearch(query, {
            topic: 'news',
            days: Math.min(Number(input['days']) || 7, 30),
            maxResults: Math.min(Number(input['maxResults']) || 5, 10),
            includeAnswer: true,
          })
        );
      } catch (err) {
        return JSON.stringify({ error: `web_search failed: ${(err as Error).message}` });
      }
    }

    case 'kb_semantic_search': {
      const query = String(input['query'] ?? '');
      if (!query) return JSON.stringify({ error: 'query is required' });
      const topK = Math.min(Math.max(Number(input['top_k']) || 6, 1), 15);
      try {
        const hits = await vectorKbSearch(query, topK);
        return JSON.stringify({ query, count: hits.length, hits });
      } catch (err) {
        return JSON.stringify({ error: `kb_semantic_search failed: ${(err as Error).message}` });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Build system prompt ───────────────────────────────────────────────

async function buildSystemPrompt(dailyTarget: number): Promise<string> {
  const today = todayStr();
  return `You are the Sales Briefing AI for Foot Solutions Flower Mound.
Today's date (Central Time): ${today}
Daily revenue target: $${dailyTarget.toFixed(2)}

Your job: write a TIGHT daily briefing email for the new owner. Quality over quantity.
The owner will stop reading anything that's too long.

HARD CONSTRAINTS:
- Total email body MUST be 220 words or fewer (was 180; bumped to fit the optional Network Heads-up section without crowding the rest)
- 3-5 short sections, no walls of text
- Every recommendation MUST include a verified contact (name OR phone) and address
- Use real data — call tools to fetch actual numbers, never guess
- Tone: confident, direct, like a sharp consultant — never wishy-washy
- Store is CLOSED Sunday & Monday. Never suggest events on Sun/Mon.

═══ INBOX ACCESS — cache-first, live as fallback ═══
You have read access to a LOCAL CACHE of the owner's Gmail (rolling ~6 month window) plus live Gmail as a fallback. The cache classifies every message by kind:
  - vendor   = from a known vendor brand or domain (Brooks, Dansko, Aetrex, etc.)
  - corporate= from Foot Solutions HQ (leadership, ops, marketing — Taylor, John, Jordan, Don, Gary, etc., plus production@, customerservice@, QuickBooks notifications, Voxelcare)
  - franchise= from a sister Foot Solutions store (katy@, greenville@, acworth@, etc.)
  - customer = inbound customer messages (appointment requests, fitting questions, complaints)
  - invoice  = bills with a dollar amount or due date
  - internal = mail from this store's own address (flowermound@)

PREFER cache tools — they're faster and free:
  - cache_query({ kind, vendor?, since, until, from?, text?, limit })
  - cache_vendor_activity(vendor, days?)   — vendor rollup with last contact + top senders
  - cache_read(id, dateOnly?)              — full body of a cached email
  - kb_semantic_search(query, top_k?)      — semantic / fuzzy search over message bodies. Use when the angle is conceptual ("vendors hinting at price hikes", "anything about a delayed shipment", "customers asking about fit issues") and exact-match cache_query won't find it. Cheaper than reading 10 emails to skim them.

Live Gmail tools (only when cache doesn't cover what you need):
  - scan_recent_vendor_emails(days?)       — fast 14-day vendor sweep
  - search_inbox(query, max?)              — Gmail-syntax targeted search
  - read_email(id)                         — live full body fetch

═══ WEB SEARCH (Tavily) — sparingly ═══
- web_search(query, days?, maxResults?) — last-N-day news. Use AT MOST 2 calls per email.
- Good uses: confirm a vendor announcement worth flagging, look up a Flower Mound or Denton County event date you're not 100% sure about.
- Bad uses: routine vendor names, generic queries. Skip if you don't have a sharp question.

═══ HOW TO USE THESE TOOLS IN THE BRIEFING ═══
- Today vs yesterday: ALWAYS pull both with get_sales_for_date for today AND yesterday. The owner's first question is "how did yesterday close out?" — anchor the briefing on yesterday's full-day numbers, then layer today's pace on top.
- Vendor stories: combine cache_vendor_activity + (optionally) one web_search for industry context. For fuzzy concepts (price changes, shipment slips, returns talk) reach for kb_semantic_search instead of guessing keywords.
- Corporate signals: cache_query({ kind: 'corporate', since: '<7 days ago>' }) → flag if HQ sent a regional sales report, marketing minute, training call, council vote, or system maintenance notice the owner should act on.
- Franchise signals: cache_query({ kind: 'franchise', since: '<3 days ago>' }) → mention if sister stores are reporting wins/losses on shared threads (peer benchmarks).
- Customer signals: cache_query({ kind: 'customer', since: '<3 days ago>' }) plus a kb_semantic_search for "customer complaint" or "appointment request" if the cache_query is thin → flag unanswered messages.
- Theme sweeps: when you suspect a recurring concern (e.g. "fit issues with the new Brooks model", "rep coverage gap"), kb_semantic_search is faster than scanning many threads.

WHEN NOT TO USE INBOX TOOLS:
- Do not list random emails. Inbox hits should only inform recommendations.
- Do not quote email content verbatim in the briefing — paraphrase briefly.
- Do not reference personal/sensitive content. Stick to business signals.

If an inbox finding produces a strong follow-up, record_opportunity with priority based on time-sensitivity.

═══ MEMORY & CONTINUITY (this is critical) ═══
You are the same agent every night. Use the opportunity ledger to keep
strategic items moving instead of starting fresh daily.

REQUIRED WORKFLOW for every email (do these in order):

1. FETCH: Call get_pending_opportunities AND scan_recent_vendor_emails first.
2. UPDATE STATE: For each pending opportunity, decide:
   - If the event date passed → mark_opportunity_done with outcome.
   - If priority is 8-10 (critical, time-sensitive) → include it in today's email,
     then call update_opportunity with mentionedToday=true.
   - If priority is 5-7 (important) and daysSinceLastMention >= 2 → include it,
     then call update_opportunity with mentionedToday=true.
   - If priority is 2-4 (notable) and mentionCount === 0 → include it once,
     then update_opportunity with mentionedToday=true.
   - Otherwise skip — don't repeat.
3. DISCOVER NEW: Look at today's sales data. If you spot a new opportunity
   (urgent reorder, upcoming event, partnership opening), call record_opportunity
   to save it for future emails. Set priority based on impact:
     10 = revenue-critical (e.g. top brand at 0 stock, lost sale risk)
      8 = high-value time-bound (e.g. paid sponsorship deadline this week)
      6 = solid recurring opportunity (e.g. monthly senior center demo)
      4 = nice-to-have (e.g. one-off chamber mixer)
      2 = informational
4. WRITE EMAIL: Use the structure below. Pull 1-2 high-impact items from
   pending + new discoveries. Don't list every opportunity — pick the most
   urgent and impactful for today.

This means high-priority items will appear in 3-5 emails until done.
Medium priority shows every 2-3 days. Low priority shows once.
Never repeat completed items. Never include all pending — be selective.

REQUIRED EMAIL STRUCTURE:

🎯 STATUS LINE (one line, with emoji):
   "BEAT TARGET" / "MISSED TARGET BY $X" / "ON PACE" / "NO SALES TODAY"

📊 STATS (3 bullets max, one line each):
   - Today: $X · N tickets · avg $Y
   - vs target / vs yesterday
   - One standout: top rep, top brand, or notable trend

💡 ONE OR TWO HIGH-IMPACT MOVES (the meat — 2-3 sentences each):
   Pull from pending opportunities (priority-driven) OR discover new ones
   from today's data. Each move MUST include:
     - WHO (target market segment)
     - WHERE (venue name + full street address)
     - WHEN (specific date Tue–Sat only — never Sun/Mon)
     - HOW TO REACH (contact name + phone, drawn from the venue list below)

   If you're re-mentioning a tracked opportunity, frame it as a follow-up:
   "Reminder: …" or "Still open: …" or "Update on …" — not as new.

🏥 ONE QUICK INSIGHT (1 sentence):
   A small but impactful observation about today's data — e.g. margin opportunity,
   a brand that's slowing, a customer pattern.

📨 NETWORK HEADS-UP (0-2 lines, only when there is real signal):
   - Anything from HQ today/yesterday that needs action: regional report deadline,
     marketing minute with a CTA, council vote, system maintenance, training call,
     leadership announcement. Keep it to one sentence per item.
   - If a sister store posted something relevant on a shared thread (a vendor tip,
     a customer outcome, a regional trend), summarize it in one sentence.
   - Skip this section entirely if nothing new from corporate or sister stores
     reaches the bar of "owner action or awareness needed."
   - Always cite the source: "(HQ — Taylor, Mon)" or "(Katy store, Sun)".

DO NOT include generic advice. DO NOT pad. DO NOT explain your reasoning in the email.
DO NOT mention the opportunity ledger system to the reader — keep it invisible.
Use the curated market intelligence below to ground every suggestion in real local geography.
Always pull contact info (names + phones) from the venue list — never invent.

${LOCAL_INTELLIGENCE}

Begin by calling get_pending_opportunities, then gather sales data, then write
the email body in plain text (no markdown, no asterisks). Use the emoji headers
shown above. After writing the email, remember to call update_opportunity for
each item you mentioned (so the mention counter increments).`;
}

// ── HTML email template ─────────────────────────────────────────────

function wrapEmailHtml(bodyText: string, today: string, status: 'beat' | 'miss' | 'pace' | 'none'): string {
  const statusColors = {
    beat: '#10b981',
    miss: '#ef4444',
    pace: '#3b82f6',
    none: '#6b7280',
  };
  const statusBg = statusColors[status];

  // Convert plaintext body to safe HTML — preserve line breaks, no markdown
  const htmlBody = bodyText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="margin: 0 0 12px 0; line-height: 1.55;">${line}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Foot Solutions Daily Briefing — ${today}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="background:${statusBg};padding:18px 24px;color:#ffffff;">
          <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:1px;opacity:0.9;">DAILY BRIEFING</p>
          <p style="margin:4px 0 0 0;font-size:18px;font-weight:700;">${today}</p>
        </td></tr>
        <tr><td style="padding:24px;font-size:14px;color:#1e293b;">
          ${htmlBody}
        </td></tr>
        <tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;">
          Foot Solutions Flower Mound · Generated by your AI assistant · <a href="https://fsmanagementsystem.com" style="color:#3b82f6;text-decoration:none;">Open dashboard</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Get daily target from admin settings ─────────────────────────────

async function getDailyTarget(): Promise<number> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { userId: OWNER_USER_ID, sk: 'ADMIN#SETTINGS' },
  }));
  return (result.Item?.['dailyTarget'] as number) ?? 1500; // default $1,500/day
}

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (event?: { trigger?: string }) => {
  const today = todayStr();
  const dow = ctDayOfWeek();

  // Skip Sunday (0) and Monday (1) — store is closed those days.
  // Allow manual triggers (`trigger === 'manual'` or `'manual-test'`) to bypass.
  const isManual = event?.trigger?.startsWith('manual') ?? false;
  if (STORE_CLOSED_DAYS_OF_WEEK.has(dow) && !isManual) {
    console.log(`Skipping daily report for ${today} (day of week ${dow} — store closed)`);
    return { ok: true, skipped: true, reason: 'store-closed-day' };
  }

  console.log(`Daily report start for ${today}`);

  const dailyTarget = await getDailyTarget();
  const systemPrompt = await buildSystemPrompt(dailyTarget);

  // Agentic tool-use loop — model fetches data, then writes email
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ text: `Generate today's briefing for ${today}. Daily target is $${dailyTarget.toFixed(2)}. Use the tools to fetch real numbers first, then write a tight email per the structure rules.` }],
    },
  ];

  let emailBody = '';
  // 16 rounds: enough for memory fetch + inbox scan + sales tools + per-mention updates + final write
  const MAX_ROUNDS = 16;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await bedrockClient.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages,
      toolConfig: { tools: TOOLS },
      inferenceConfig: { maxTokens: 1500, temperature: 0.4 },
    }));

    const assistantContent = response.output?.message?.content ?? [];
    const stopReason = response.stopReason;
    messages.push({ role: 'assistant', content: assistantContent as ContentBlock[] });

    if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
      const textBlock = assistantContent.find((b) => 'text' in b);
      if (textBlock && 'text' in textBlock) emailBody = (textBlock.text ?? '').trim();
      break;
    }

    if (stopReason === 'tool_use') {
      const toolUseBlocks = assistantContent.filter((b) => 'toolUse' in b);
      const toolResults = (await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (!('toolUse' in block) || !block.toolUse) {
            return { toolResult: { toolUseId: 'unknown', content: [{ text: 'Invalid tool call' }] } };
          }
          const { toolUseId, name, input } = block.toolUse;
          console.log(`Tool: ${name}`, JSON.stringify(input));
          try {
            const result = await executeTool(name ?? '', (input ?? {}) as Record<string, unknown>);
            return { toolResult: { toolUseId: toolUseId ?? '', content: [{ text: result }], status: 'success' as const } };
          } catch (err) {
            return { toolResult: { toolUseId: toolUseId ?? '', content: [{ text: `Error: ${(err as Error).message}` }], status: 'error' as const } };
          }
        })
      )) as unknown as ToolResultContentBlock[];
      messages.push({ role: 'user', content: toolResults as ContentBlock[] });
      continue;
    }
    break;
  }

  if (!emailBody) {
    emailBody = '⚠️ No briefing generated today. Check Lambda logs for details.';
  }

  // Determine status from email body for the colored header bar
  const lowerBody = emailBody.toLowerCase();
  const status: 'beat' | 'miss' | 'pace' | 'none' =
    lowerBody.includes('no sales') ? 'none' :
    lowerBody.includes('beat target') ? 'beat' :
    lowerBody.includes('missed target') ? 'miss' :
    'pace';

  // Format a friendly subject line. Gmail and Outlook spam classifiers
  // sometimes flag emoji + middot characters as bulk/promotional, so we
  // keep the subject plain and conversational.
  const subjectDate = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date());
  const subject = `Foot Solutions Daily Briefing — ${subjectDate}`;
  const htmlBody = wrapEmailHtml(emailBody, today, status);

  // Send email via SES
  let sendStatus: 'sent' | 'failed' = 'sent';
  let sendError: string | null = null;
  let sentMessageId: string | null = null;
  try {
    const result = await sesClient.send(new SendEmailCommand({
      // Friendly From: name to improve open rate and recognition
      FromEmailAddress: `Foot Solutions Briefing <${FROM_ADDRESS}>`,
      Destination: { ToAddresses: [TO_ADDRESS] },
      // Note: intentionally NOT setting ReplyToAddresses to TO_ADDRESS —
      // Reply-To equal to the recipient is a known spam-classifier
      // trigger ("self-reply" pattern). Letting Gmail/Outlook fall back
      // to the From address gives cleaner inbox placement.
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: htmlBody, Charset: 'UTF-8' },
            Text: { Data: emailBody, Charset: 'UTF-8' },
          },
          Headers: [
            // List-Unsubscribe headers improve sender reputation with Gmail/Outlook
            // even though this is a low-volume internal email. The mailto: form
            // satisfies RFC 2369. Recipient can ignore — no real list to unsub from.
            { Name: 'List-Unsubscribe', Value: `<mailto:${TO_ADDRESS}?subject=unsubscribe>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
            // Identify this as a transactional/business briefing
            { Name: 'X-Entity-Ref-ID', Value: `daily-briefing-${today}` },
          ],
        },
      },
      // Send via the default configuration set (SES picks one if not specified).
      // Use ConfigurationSetName here later if you set up bounce/complaint tracking.
    }));
    sentMessageId = result.MessageId ?? null;
    console.log(`Email sent to ${TO_ADDRESS} (MessageId=${sentMessageId ?? 'unknown'})`);
  } catch (err) {
    sendStatus = 'failed';
    sendError = (err as Error).message;
    console.error('SES send failed:', sendError);
  }

  // Persist to DynamoDB for the dashboard email feed
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: `EMAIL#${today}`,
      date: today,
      subject,
      bodyText: emailBody,
      bodyHtml: htmlBody,
      status,
      sendStatus,
      sendError,
      sentMessageId,
      to: TO_ADDRESS,
      from: FROM_ADDRESS,
      generatedAt: new Date().toISOString(),
    },
  }));

  return { ok: sendStatus === 'sent', status, sendStatus, sendError };
};
