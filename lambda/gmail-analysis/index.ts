/**
 * Gmail Analysis Lambda — two routes:
 *
 *   POST /gmail/analyze   — structured digest of the last N days of email.
 *                           Cached in DynamoDB at sk=GMAIL#ANALYSIS#LATEST,
 *                           recomputed on demand or when older than 6h.
 *   POST /gmail/chat      — agentic chat over the inbox (Bedrock Converse +
 *                           tool use), mirrors the Sales /pos/chat handler.
 *
 * Reuses lambda/gmail/client.ts which handles OAuth refresh against
 *   foot-solutions/gmail/oauth-client    — { client_id, client_secret }
 *   foot-solutions/gmail/refresh-token   — { refresh_token, email }
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { searchEmails, getMessage } from '../gmail/client';
import {
  cacheQuery,
  cacheRead,
  cacheVendorActivity,
  cacheStats,
  type CachedQueryArgs,
} from './cache';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const MODEL_ID =
  process.env['BEDROCK_MODEL_ID'] ??
  'global.anthropic.claude-sonnet-4-6';

const STORE_TZ = 'America/Chicago';
const ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ANALYSIS_SK = 'GMAIL#ANALYSIS#LATEST';

// ── Helpers ──────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function ctDateStr(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// ── Structured-analysis schema ───────────────────────────────────────
//
// The model must return the analysis by calling the `submit_analysis`
// tool with this exact shape. Using a tool spec (instead of "return JSON")
// gives us reliable validation and avoids parse failures.

interface GmailEvent {
  title: string;
  date: string | null;
  location: string | null;
  contactName: string | null;
  contactEmail: string | null;
  summary: string;
  sourceMessageIds: string[];
}

interface GmailVendor {
  name: string;
  messageCount: number;
  topics: string[];
  actionItems: string[];
  sourceMessageIds: string[];
}

interface GmailInvoice {
  vendor: string;
  amount: number | null;
  dueDate: string | null;
  summary: string;
  sourceMessageId: string;
}

interface GmailInquiry {
  from: string;
  subject: string;
  date: string;
  priority: 'high' | 'medium' | 'low';
  summary: string;
  sourceMessageId: string;
}

interface GmailFollowUp {
  title: string;
  why: string;
  suggestedAction: string;
  sourceMessageIds: string[];
}

interface GmailAnalysis {
  overview: string;
  events: GmailEvent[];
  vendors: GmailVendor[];
  invoices: GmailInvoice[];
  customerInquiries: GmailInquiry[];
  followUpsNeeded: GmailFollowUp[];
  topSenders: Array<{ from: string; count: number }>;
}

interface CachedAnalysis extends GmailAnalysis {
  generatedAt: string;
  rangeDays: number;
  totalMessagesScanned: number;
  modelId: string;
}

const SUBMIT_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    overview: {
      type: 'string',
      description:
        '2-3 sentence executive summary of what came through the inbox in this window.',
    },
    events: {
      type: 'array',
      description:
        'Trade shows, demos, networking events, training sessions, or invitations. Empty array if none.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD if you can identify it, else null',
          },
          location: { type: ['string', 'null'] },
          contactName: { type: ['string', 'null'] },
          contactEmail: { type: ['string', 'null'] },
          summary: { type: 'string' },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'sourceMessageIds'],
      },
    },
    vendors: {
      type: 'array',
      description:
        'One entry per vendor brand or supplier with relevant inbox activity (Brooks, Dansko, Aetrex, Hoka, etc.). Aggregate threads by vendor.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          messageCount: { type: 'number' },
          topics: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Short tags like "new collection", "backorder", "co-op promo", "rep visit", "invoice"',
          },
          actionItems: { type: 'array', items: { type: 'string' } },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'messageCount', 'topics', 'sourceMessageIds'],
      },
    },
    invoices: {
      type: 'array',
      description:
        'Bills, invoices, or payment requests. Pull the amount and due date when present.',
      items: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          amount: { type: ['number', 'null'] },
          dueDate: { type: ['string', 'null'] },
          summary: { type: 'string' },
          sourceMessageId: { type: 'string' },
        },
        required: ['vendor', 'summary', 'sourceMessageId'],
      },
    },
    customerInquiries: {
      type: 'array',
      description:
        'Direct customer messages — appointment requests, complaints, product questions, fitting requests.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          subject: { type: 'string' },
          date: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          summary: { type: 'string' },
          sourceMessageId: { type: 'string' },
        },
        required: ['from', 'subject', 'date', 'priority', 'summary', 'sourceMessageId'],
      },
    },
    followUpsNeeded: {
      type: 'array',
      description:
        'Things the owner has not yet replied to or finished. Be specific.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          suggestedAction: { type: 'string' },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'why', 'suggestedAction', 'sourceMessageIds'],
      },
    },
    topSenders: {
      type: 'array',
      description: 'Top 5-10 most-frequent senders in the window.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['from', 'count'],
      },
    },
  },
  required: [
    'overview',
    'events',
    'vendors',
    'invoices',
    'customerInquiries',
    'followUpsNeeded',
    'topSenders',
  ],
} as const;

// ── Tool specs (Bedrock Converse) ────────────────────────────────────

const ANALYZE_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'cache_query',
      description:
        "Query the local Gmail cache. Use this FIRST for any inbox dive — it's faster than live Gmail. Combine vendor + since/until + kind + from + text + threadId. Returns metadata; call cache_read for bodies.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['invoice', 'vendor', 'customer', 'internal'],
            },
            since: { type: 'string' },
            until: { type: 'string' },
            from: { type: 'string' },
            text: { type: 'string' },
            threadId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: [],
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
  {
    toolSpec: {
      name: 'live_read_email',
      description:
        'Fallback only — fetch a message that is not in the cache (very recent, or older than the cache window).',
      inputSchema: {
        json: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'live_search_inbox',
      description: 'Fallback only — Gmail search for ranges outside cache coverage.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            max: { type: 'number' },
          },
          required: ['query'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'submit_analysis',
      description:
        'Submit your final structured analysis. Call this exactly once when finished. The arguments must match the schema.',
      inputSchema: {
        // SUBMIT_ANALYSIS_SCHEMA is JSON Schema — the AWS SDK types it as
        // DocumentType (an open shape) so we cast through unknown.
        json: SUBMIT_ANALYSIS_SCHEMA as unknown as Record<string, never>,
      },
    },
  },
];

const CHAT_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'cache_query',
      description:
        "Query the local Gmail cache (last 6-12 months of the owner's inbox, indexed for fast filtering). Use this for almost every question. Combine vendor + since/until + kind for narrow results, or use text/from for free-text. Returns lightweight metadata; call cache_read for full bodies.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: {
              type: 'string',
              description:
                'Vendor brand name (Brooks, Dansko, Aetrex, Hoka, OluKai, Drew, Saucony, Vionic, Mephisto, Apex, Naot, Sanita, Feetures, Yaleet, Rockport, etc.)',
            },
            kind: {
              type: 'string',
              enum: ['invoice', 'vendor', 'customer', 'internal'],
              description:
                'Filter by message classification: invoice, vendor (from a vendor), customer (inbound customer message), or internal (from an @footsolutions.com address).',
            },
            since: {
              type: 'string',
              description: 'YYYY-MM-DD inclusive lower bound on message date.',
            },
            until: {
              type: 'string',
              description: 'YYYY-MM-DD inclusive upper bound on message date.',
            },
            from: {
              type: 'string',
              description:
                'Substring filter on the From: header (case-insensitive). Use for "from a particular email/domain/person".',
            },
            text: {
              type: 'string',
              description:
                'Substring filter on subject + snippet (case-insensitive). Use sparingly — vendor/kind/from filters are faster and more accurate.',
            },
            threadId: {
              type: 'string',
              description: 'Restrict to a single Gmail thread.',
            },
            limit: { type: 'number', description: 'Default 25, max 100' },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'cache_read',
      description:
        'Read the full headers + plaintext body of one cached email by its message ID and dateOnly (both returned by cache_query). Use after cache_query when you need the actual content.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Gmail message id' },
            dateOnly: {
              type: 'string',
              description: 'YYYY-MM-DD message date — speeds up the read.',
            },
          },
          required: ['id'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'cache_vendor_activity',
      description:
        "Get a quick rollup of a vendor's email activity over the last N days: message count, last contact date, top senders, top subjects, recent message IDs. Use to answer 'what has Brooks been up to' or 'when did we last hear from Aetrex'.",
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
      name: 'cache_stats',
      description:
        'Get coverage stats for the local cache (oldest/newest message date, totals by kind). Useful for answering "do I have anything from January" before a long search.',
      inputSchema: {
        json: { type: 'object', properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: 'live_search_inbox',
      description:
        "Fallback: search the LIVE Gmail inbox using Gmail query syntax. Use ONLY when the cache_stats coverage doesn't cover the date range you need (i.e. older than the cache, or freshly arrived in the last hour). Slower and rate-limited compared to cache_query.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            max: { type: 'number', description: 'Default 10, hard cap 25' },
          },
          required: ['query'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'live_read_email',
      description:
        'Fallback: read a live Gmail message by ID (use if live_search_inbox returned an id not yet in cache).',
      inputSchema: {
        json: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  },
];

// ── Tool execution shared between analyze + chat ─────────────────────

async function fetchMessageMetadata(id: string) {
  // Body truncated to 0 chars — we only want headers + snippet for the seed.
  const msg = await getMessage(id, 0);
  return {
    id: msg.id,
    from: msg.from,
    subject: msg.subject,
    date: msg.date,
    snippet: msg.snippet,
  };
}

async function execSearchInbox(input: Record<string, unknown>): Promise<string> {
  const query = String(input['query'] ?? '').trim();
  if (!query) return JSON.stringify({ error: 'query is required' });
  const max = Math.min(Number(input['max']) || 10, 25);
  try {
    const matches = await searchEmails(query, max);
    return JSON.stringify({ query, count: matches.length, messages: matches });
  } catch (err) {
    return JSON.stringify({ error: `search_inbox failed: ${(err as Error).message}` });
  }
}

async function execReadEmail(input: Record<string, unknown>): Promise<string> {
  const id = String(input['id'] ?? '').trim();
  if (!id) return JSON.stringify({ error: 'id is required' });
  try {
    const msg = await getMessage(id);
    return JSON.stringify(msg);
  } catch (err) {
    return JSON.stringify({ error: `read_email failed: ${(err as Error).message}` });
  }
}

async function execListRecent(input: Record<string, unknown>): Promise<string> {
  const days = Math.min(Number(input['days']) || 7, 30);
  const max = Math.min(Number(input['max']) || 20, 50);
  const query = `newer_than:${days}d -category:promotions -category:social`;
  try {
    const matches = await searchEmails(query, max);
    if (matches.length === 0) {
      return JSON.stringify({ days, count: 0, messages: [] });
    }
    const detailed = await Promise.all(
      matches.map(async (m) => {
        try {
          return await fetchMessageMetadata(m.id);
        } catch {
          return { id: m.id, from: '', subject: '', date: '', snippet: '' };
        }
      })
    );
    return JSON.stringify({ days, count: detailed.length, messages: detailed });
  } catch (err) {
    return JSON.stringify({ error: `list_recent failed: ${(err as Error).message}` });
  }
}

// ── Build the seed metadata for the analyze pass ─────────────────────

interface SeedMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

async function fetchSeedMetadata(days: number, cap: number): Promise<SeedMessage[]> {
  // Prefer the local cache. If the cache doesn't yet cover this window,
  // fall back to live Gmail.
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const cacheRes = await cacheQuery({ since, limit: cap });

  if (cacheRes.rows.length > 0) {
    return cacheRes.rows.map((r) => ({
      id: r.id,
      from: r.from,
      subject: r.subject,
      date: r.date,
      snippet: r.snippet,
    }));
  }

  // Cache empty (e.g. first run before backfill) — fall back to live.
  const query = `newer_than:${days}d -category:promotions -category:social`;
  const matches = await searchEmails(query, cap);
  if (matches.length === 0) return [];
  const detailed = await Promise.all(
    matches.map(async (m) => {
      try {
        return await fetchMessageMetadata(m.id);
      } catch {
        return null;
      }
    })
  );
  return detailed.filter((m): m is SeedMessage => m !== null);
}

// ── Analyze handler ──────────────────────────────────────────────────

async function getCachedAnalysis(): Promise<CachedAnalysis | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: ANALYSIS_SK },
    })
  );
  return (result.Item as unknown as CachedAnalysis) ?? null;
}

async function saveCachedAnalysis(analysis: CachedAnalysis): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: ANALYSIS_SK,
        ...analysis,
      },
    })
  );
}

function buildAnalyzeSystemPrompt(days: number, totalScanned: number): string {
  return `You are an email analyst for the new owner of Foot Solutions Flower Mound, a specialty footwear retail store.

Your job: read the last ${days} days of inbox metadata (and dig deeper with tools when needed) and produce a structured analysis the owner can scan in under 60 seconds.

You have ${totalScanned} message snippets in the seed below — they come from the LOCAL CACHE (a rolling ~6 month copy of the inbox). You can call:
- cache_read(id, dateOnly) — fetch the full body of any cached thread
- cache_query({ vendor, kind, since, until, from, text }) — re-query the cache with different filters
- live_search_inbox / live_read_email — fallbacks for messages not yet in the cache

Categories the owner cares about most:
- Events: trade shows, demos, training, networking, in-person invitations
- Vendors: Brooks, Dansko, Aetrex, Hoka, OluKai, Drew, Saucony, Vionic, Mephisto, Apex, Naot, Yaleet, etc. — anything about new collections, backorders, co-op promos, rep visits, returns
- Invoices and bills with dollar amounts and due dates (kind=invoice in cache)
- Customer inquiries: appointment requests, complaints, product questions (kind=customer in cache)
- Follow-ups the owner owes to someone (unanswered threads where the ball is in their court)
- Top senders by message count

Hard rules:
- Never invent details. If you cannot determine an event date, set it to null.
- Read the actual email body when assigning amounts, dates, or contact names. Snippets alone are not enough.
- Cap each list to the most useful 8-10 items. Skip noise.
- Group vendor activity by brand — one entry per vendor with messageCount, not one per email.
- For follow-ups, only include threads where the owner clearly owes a reply or action.
- When you are done, call submit_analysis with the structured result. Do this exactly once.

Begin by reviewing the seed. Use cache_read sparingly — at most 8-10 calls, prioritizing invoices, vendor threads, and ambiguous customer messages.`;
}

async function runAnalyze(days: number): Promise<CachedAnalysis> {
  const seedCap = 80;
  const seed = await fetchSeedMetadata(days, seedCap);

  const seedText =
    seed.length === 0
      ? '(No non-promotional emails in this window.)'
      : seed
          .map(
            (m, i) =>
              `[${i + 1}] id=${m.id} | ${m.date} | from: ${m.from} | subject: ${m.subject}\n     snippet: ${m.snippet.slice(0, 240)}`
          )
          .join('\n');

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          text: `Seed metadata (last ${days} days, ${seed.length} messages):\n\n${seedText}\n\nProduce the structured analysis now.`,
        },
      ],
    },
  ];

  const MAX_ROUNDS = 12;
  let analysis: GmailAnalysis | null = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: buildAnalyzeSystemPrompt(days, seed.length) }],
        messages,
        toolConfig: { tools: ANALYZE_TOOLS },
        inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
      })
    );

    const assistantContent = response.output?.message?.content ?? [];
    messages.push({ role: 'assistant', content: assistantContent as ContentBlock[] });

    const stopReason = response.stopReason;

    if (stopReason === 'tool_use') {
      const toolBlocks = assistantContent.filter((b) => 'toolUse' in b);
      const toolResults: ContentBlock[] = [];

      for (const block of toolBlocks) {
        if (!('toolUse' in block) || !block.toolUse) continue;
        const { toolUseId, name, input } = block.toolUse;
        const inp = (input ?? {}) as Record<string, unknown>;

        if (name === 'submit_analysis') {
          // The model has emitted its final answer.
          analysis = inp as unknown as GmailAnalysis;
          toolResults.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify({ ok: true }) }],
              status: 'success',
            },
          });
        } else if (name === 'cache_query') {
          const result = JSON.stringify(await cacheQuery(inp as CachedQueryArgs));
          toolResults.push({
            toolResult: { toolUseId: toolUseId ?? '', content: [{ text: result }], status: 'success' },
          });
        } else if (name === 'cache_read') {
          const id = String(inp['id'] ?? '');
          const dateOnly = String(inp['dateOnly'] ?? '') || undefined;
          const m = await cacheRead(id, dateOnly);
          toolResults.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify(m ?? { error: `Message ${id} not in cache` }) }],
              status: 'success',
            },
          });
        } else if (name === 'live_read_email') {
          const result = await execReadEmail(inp);
          toolResults.push({
            toolResult: { toolUseId: toolUseId ?? '', content: [{ text: result }], status: 'success' },
          });
        } else if (name === 'live_search_inbox') {
          const result = await execSearchInbox(inp);
          toolResults.push({
            toolResult: { toolUseId: toolUseId ?? '', content: [{ text: result }], status: 'success' },
          });
        } else {
          toolResults.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify({ error: `unknown tool ${name}` }) }],
              status: 'error',
            },
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      // If submit_analysis was called we stop; one more round will let the
      // model wrap up but is not strictly needed.
      if (analysis) break;
      continue;
    }

    // end_turn or max_tokens without submitting — break and try to recover.
    break;
  }

  if (!analysis) {
    throw new Error(
      'Model did not call submit_analysis — analysis incomplete. Try again.'
    );
  }

  // Light validation + defaults
  const safe: CachedAnalysis = {
    overview: analysis.overview ?? '',
    events: Array.isArray(analysis.events) ? analysis.events : [],
    vendors: Array.isArray(analysis.vendors) ? analysis.vendors : [],
    invoices: Array.isArray(analysis.invoices) ? analysis.invoices : [],
    customerInquiries: Array.isArray(analysis.customerInquiries)
      ? analysis.customerInquiries
      : [],
    followUpsNeeded: Array.isArray(analysis.followUpsNeeded)
      ? analysis.followUpsNeeded
      : [],
    topSenders: Array.isArray(analysis.topSenders) ? analysis.topSenders : [],
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    totalMessagesScanned: seed.length,
    modelId: MODEL_ID,
  };

  await saveCachedAnalysis(safe);
  return safe;
}

// ── Chat handler ─────────────────────────────────────────────────────

function buildChatSystemPrompt(): string {
  const today = ctDateStr();
  return `You are the Inbox Assistant for the new owner of Foot Solutions Flower Mound.
Today's date (Central Time): ${today}

You have read access to a LOCAL CACHE of the owner's Gmail (rolling ~6-12 month window, indexed for fast queries) plus live Gmail as a fallback.

PREFER cache tools — they are faster and free:
  - cache_query({ vendor?, kind?, since?, until?, from?, text?, threadId?, limit? })
  - cache_read(id, dateOnly?)              → full body of a cached message
  - cache_vendor_activity(vendor, days?)   → vendor rollup with last contact + top senders
  - cache_stats()                          → check coverage before searching

Use live tools ONLY if cache_stats shows the cache doesn't cover the range you need:
  - live_search_inbox(query, max?)
  - live_read_email(id)

Background context:
- The store sells specialty footwear, custom orthotics, and orthopedic products.
- Vendors include: Brooks, Dansko, Aetrex, Hoka, OluKai, Drew, Saucony, Vionic, Mephisto, Apex, Naot, Sanita, Feetures, Yaleet, Rockport.
- Roland and Janell are the prior owners — references to them often contain handoff context, vendor relationships, or unfinished commitments.
- Cache classifications: kind=invoice, kind=vendor (from a known vendor), kind=customer (inbound customer message), kind=internal (from an @footsolutions.com address).
- The new owner is rebuilding sales momentum, so vendor partnerships, events, and customer follow-ups matter.

Guidelines:
- Use tools to ground every answer in actual inbox content. Do not guess.
- Quote subject lines and senders, but paraphrase email bodies — do not paste large blocks of email text.
- Be concise. The owner wants the answer, not a transcript.
- If the cache returns nothing AND coverage spans the date range, say "I checked the inbox and didn't find anything matching" rather than escalating to live search.
- Always cite source message IDs as inline references like "(msg 18a3f...)" so the owner can find the thread.
- If asked something unrelated to the inbox, say you can only answer questions grounded in their email.`;
}

interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

async function runChat(rawMessages: ChatMessageInput[]): Promise<string> {
  const bedrockMessages: Message[] = rawMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: [{ text: m.content }] }));

  while (bedrockMessages.length > 0 && bedrockMessages[0]?.role === 'assistant') {
    bedrockMessages.shift();
  }
  if (bedrockMessages.length === 0) {
    throw new Error('No valid user messages provided');
  }

  const MAX_ROUNDS = 6;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: buildChatSystemPrompt() }],
        messages: bedrockMessages,
        toolConfig: { tools: CHAT_TOOLS },
        inferenceConfig: { maxTokens: 1500, temperature: 0.3 },
      })
    );

    const assistantContent = response.output?.message?.content ?? [];
    const stopReason = response.stopReason;

    bedrockMessages.push({ role: 'assistant', content: assistantContent as ContentBlock[] });

    if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
      const textBlock = assistantContent.find((b) => 'text' in b);
      return textBlock && 'text' in textBlock
        ? textBlock.text!
        : 'Sorry, I could not generate a response.';
    }

    if (stopReason === 'tool_use') {
      const toolBlocks = assistantContent.filter((b) => 'toolUse' in b);
      const toolResults: ContentBlock[] = await Promise.all(
        toolBlocks.map(async (block) => {
          if (!('toolUse' in block) || !block.toolUse) {
            return {
              toolResult: {
                toolUseId: 'unknown',
                content: [{ text: 'Invalid tool call' }],
                status: 'error' as const,
              },
            };
          }
          const { toolUseId, name, input } = block.toolUse;
          const inp = (input ?? {}) as Record<string, unknown>;
          let result: string;
          try {
            switch (name) {
              case 'cache_query': {
                const q = await cacheQuery(inp as CachedQueryArgs);
                result = JSON.stringify(q);
                break;
              }
              case 'cache_read': {
                const id = String(inp['id'] ?? '');
                const dateOnly = String(inp['dateOnly'] ?? '') || undefined;
                const m = await cacheRead(id, dateOnly);
                result = JSON.stringify(m ?? { error: `Message ${id} not in cache` });
                break;
              }
              case 'cache_vendor_activity': {
                const vendor = String(inp['vendor'] ?? '');
                const days = Math.min(Number(inp['days']) || 90, 365);
                const v = await cacheVendorActivity(vendor, days);
                result = JSON.stringify(v);
                break;
              }
              case 'cache_stats': {
                const s = await cacheStats();
                result = JSON.stringify(s);
                break;
              }
              case 'live_search_inbox':
                result = await execSearchInbox(inp);
                break;
              case 'live_read_email':
                result = await execReadEmail(inp);
                break;
              default:
                result = JSON.stringify({ error: `unknown tool ${name}` });
            }
          } catch (err) {
            result = JSON.stringify({ error: (err as Error).message });
          }
          return {
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: result }],
              status: 'success' as const,
            },
          };
        })
      );
      bedrockMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'I was unable to complete the request. Please try again.';
}

// ── Route dispatch ───────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey;

  try {
    if (route === 'POST /gmail/analyze') {
      let body: { days?: number; refresh?: boolean } = {};
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const days = Math.min(Math.max(Number(body.days) || 14, 1), 180);
      const refresh = !!body.refresh;

      // Try cache first
      if (!refresh) {
        const cached = await getCachedAnalysis();
        if (
          cached &&
          cached.rangeDays === days &&
          cached.generatedAt &&
          Date.now() - new Date(cached.generatedAt).getTime() < ANALYSIS_CACHE_TTL_MS
        ) {
          return json(200, { ...cached, fromCache: true });
        }
      }

      const fresh = await runAnalyze(days);
      return json(200, { ...fresh, fromCache: false });
    }

    if (route === 'GET /gmail/analyze') {
      // Convenience: return whatever's cached without recomputing
      const cached = await getCachedAnalysis();
      if (!cached) return json(404, { error: 'No analysis cached yet' });
      return json(200, { ...cached, fromCache: true });
    }

    if (route === 'POST /gmail/chat') {
      let body: { messages?: ChatMessageInput[] };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const msgs = body.messages ?? [];
      if (msgs.length === 0) return json(400, { error: 'messages array is required' });
      const reply = await runChat(msgs);
      return json(200, { reply });
    }

    if (route === 'GET /gmail/cache-stats') {
      const stats = await cacheStats();
      return json(200, stats);
    }

    return json(404, { error: `Unknown route ${route}` });
  } catch (err) {
    console.error('gmail-analysis error:', (err as Error).message, (err as Error).stack);
    return json(500, { error: (err as Error).message });
  }
};
