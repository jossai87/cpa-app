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
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
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
  resolveThreadIds,
  type CachedQueryArgs,
} from './cache';
import { tavilySearch } from '../shared/tavily';
import { kbSemanticSearch as vectorKbSearch } from '../shared/vectorIndex';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambdaClient = new LambdaClient({ region: 'us-east-1' });

const SELF_FUNCTION_NAME = process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? 'foot-solutions-gmail-analysis';

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const MODEL_ID =
  process.env['BEDROCK_MODEL_ID'] ??
  'global.anthropic.claude-haiku-4-5-20251001-v1:0';

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
      name: 'kb_semantic_search',
      description:
        "Semantic search over the full text of cached Gmail messages (Cohere embeddings + S3 Vectors). Use when the question is conceptual or fuzzy ('emails about pricing concerns', 'anything mentioning a delayed delivery', 'complaints about fit') and exact-match cache_query (vendor / from / text) won't find it. Returns up to top_k message metadata + a body preview, ranked by similarity. Follow up with cache_read for full bodies.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural-language search query.',
            },
            top_k: {
              type: 'number',
              description: 'Default 8, max 25.',
            },
          },
          required: ['query'],
        },
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

You have ${totalScanned} message snippets in the seed below — they come from the LOCAL CACHE (a rolling ~6 month copy of the inbox). Available tools:
- cache_read(id, dateOnly) — fetch the full body of any cached thread
- cache_query({ vendor, kind, since, until, from, text }) — re-query the cache with different filters
- live_search_inbox / live_read_email — fallbacks for messages not yet in the cache
- submit_analysis(...) — submit your final structured result

Categories the owner cares about most:
- Events: trade shows, demos, training, networking, in-person invitations
- Vendors: Brooks, Dansko, Aetrex, Hoka, OluKai, Drew, Saucony, Vionic, Mephisto, Apex, Naot, Yaleet, etc. — anything about new collections, backorders, co-op promos, rep visits, returns
- Invoices and bills with dollar amounts and due dates (kind=invoice in cache)
- Customer inquiries: appointment requests, complaints, product questions (kind=customer in cache)
- Follow-ups the owner owes to someone (unanswered threads where the ball is in their court)
- Top senders by message count

CRITICAL workflow rules — follow exactly:
1. The seed already gives you enough to draft top_senders, group vendors, and identify candidate items.
2. You may call cache_read at most 6 times to fill in details for the most important threads (top invoices, top vendor threads, ambiguous customer messages). DO NOT exceed 6 cache_read calls.
3. You may call cache_query at most 2 times for narrow follow-ups. DO NOT exceed 2 cache_query calls.
4. You MUST call submit_analysis as your final action. Failure to call submit_analysis means the owner sees nothing.
5. If you are uncertain about a detail, leave the field null/empty rather than calling more tools — the owner prefers a partial answer over a missing one.
6. Hard rule: by your 8th total tool call, submit_analysis MUST be the next call.

CRITICAL — message IDs (do not get this wrong):
- Every sourceMessageIds / sourceMessageId you return MUST be an EXACT string copied from the seed (e.g. "19e4c8a0798d5a47") or from a cache_query / cache_read result's id field.
- DO NOT invent IDs like "seed-brooks-rep-01" or "msg-1". DO NOT slugify subjects into IDs.
- DO NOT abbreviate or shorten the hex IDs.
- If you cannot find an actual ID for a section item, leave the array empty rather than fabricate.

Other rules:
- Never invent details. If you cannot determine an event date, set it to null.
- Cap each list to the most useful 8-10 items. Skip noise.
- Group vendor activity by brand — one entry per vendor with messageCount, not one per email.
- For follow-ups, only include threads where the owner clearly owes a reply or action.

SECTION COMPLETENESS — important:
- Look at the seed before you submit. If the seed contains messages that match a category, the corresponding array MUST NOT be empty:
  * Any message from a known vendor brand → at least one entry in vendors[]
  * Any subject/snippet matching invoice/bill/payment due → at least one entry in invoices[]
  * Any inbound customer message (kind=customer or to: footsolutions, from: an external person) → at least one entry in customerInquiries[]
  * Any unanswered question or pending request → at least one entry in followUpsNeeded[]
- Empty is only acceptable when you've checked the seed and there genuinely is no signal in this category. Don't be lazy: a 14-day window almost always has vendors and at least one invoice.
- For customer inquiries: ALWAYS use the actual sender from the email (e.g. "Jane Doe <jane@example.com>"). NEVER write generic placeholders like "Customer (unknown)" — if you don't have a real sender, drop the entry instead.

Begin by reviewing the seed. Be efficient. Submit early.`;
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

  const MAX_ROUNDS = 20;
  let analysis: GmailAnalysis | null = null;
  let lastTextResponse: string | null = null;

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

    // Capture the most recent text reply so we can fall back to it if the
    // model never calls submit_analysis.
    const textBlock = assistantContent.find((b) => 'text' in b);
    if (textBlock && 'text' in textBlock && textBlock.text) {
      lastTextResponse = textBlock.text;
    }

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

  // If the model exited without calling submit_analysis (max rounds, or
  // end_turn after exploring), give it ONE more chance with an explicit
  // "you must submit now" instruction before degrading.
  //
  // Critical: the existing `messages` array may end on an assistant
  // tool_use block without a matching tool_result (when the main loop
  // breaks out at end_turn or hits a stop reason mid-flow). Anthropic
  // strictly requires tool_use→tool_result pairing, so we rebuild the
  // history from scratch and let the toolChoice constraint force the
  // model to emit submit_analysis directly.
  if (!analysis) {
    console.warn('Model did not call submit_analysis. Forcing final submission.');
    const draftSummary = lastTextResponse
      ? `\n\nThe model wrote this draft text but did not finalize: "${lastTextResponse.slice(0, 1500)}"`
      : '';
    const forceMessages: Message[] = [
      {
        role: 'user',
        content: [
          {
            text: `Submit your final daily inbox analysis NOW for the last ${days} days of email. Use the cache_query tool data already implied by the seed below or provide your best inference. Use empty arrays for sections you cannot populate. Call submit_analysis exactly once.${draftSummary}\n\nSeed message count: ${seed.length}.`,
          },
        ],
      },
    ];
    try {
      const finalResponse = await bedrockClient.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: buildAnalyzeSystemPrompt(days, seed.length) }],
          messages: forceMessages,
          toolConfig: {
            tools: ANALYZE_TOOLS,
            toolChoice: { tool: { name: 'submit_analysis' } },
          },
          inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
        })
      );
      const finalContent = finalResponse.output?.message?.content ?? [];
      const submitBlock = finalContent.find(
        (b) => 'toolUse' in b && b.toolUse?.name === 'submit_analysis'
      );
      if (submitBlock && 'toolUse' in submitBlock && submitBlock.toolUse) {
        analysis = submitBlock.toolUse.input as unknown as GmailAnalysis;
      }
    } catch (err) {
      console.warn(
        'Force-submit retry failed:',
        (err as Error).message
      );
    }
  }

  // Last-resort: synthesize a minimal analysis from whatever text the model
  // produced. Better than 503-ing the page.
  if (!analysis) {
    analysis = {
      overview:
        lastTextResponse ??
        'Analysis was inconclusive — the model could not finalize the report. Try Re-analyze, or ask the chatbot a specific question instead.',
      events: [],
      vendors: [],
      invoices: [],
      customerInquiries: [],
      followUpsNeeded: [],
      topSenders: [],
    };
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

  // Resolve every messageId the model returned into its threadId so the
  // frontend can use Gmail's #all/<threadId> deep-link URL pattern (which
  // actually works), instead of #inbox/<messageId> (which lands on Inbox).
  await annotateAnalysisWithThreadIds(safe);

  await saveCachedAnalysis(safe);
  return safe;
}

/**
 * Walk every section of the analysis and add a parallel `sourceThreadIds`
 * (or `sourceThreadId`) populated from the cache. Modifies in place.
 *
 * Also defensively filters out any IDs that aren't valid Gmail message IDs
 * (16-char lowercase hex), since the model occasionally hallucinates
 * slugified placeholders like "seed-brooks-rep-01".
 */
function isLikelyGmailId(id: string): boolean {
  // Gmail message + thread ids are 16-char lowercase hex, sometimes 17-19.
  return /^[0-9a-f]{14,20}$/i.test(id.trim());
}

function sanitizeIds(ids: string[] | undefined): string[] {
  if (!ids) return [];
  return ids.filter(isLikelyGmailId);
}

async function annotateAnalysisWithThreadIds(safe: CachedAnalysis): Promise<void> {
  // First pass: drop hallucinated IDs everywhere
  for (const e of safe.events ?? []) e.sourceMessageIds = sanitizeIds(e.sourceMessageIds);
  for (const v of safe.vendors ?? []) v.sourceMessageIds = sanitizeIds(v.sourceMessageIds);
  for (const inv of safe.invoices ?? [])
    if (inv.sourceMessageId && !isLikelyGmailId(inv.sourceMessageId)) inv.sourceMessageId = '';
  for (const c of safe.customerInquiries ?? [])
    if (c.sourceMessageId && !isLikelyGmailId(c.sourceMessageId)) c.sourceMessageId = '';
  for (const f of safe.followUpsNeeded ?? []) f.sourceMessageIds = sanitizeIds(f.sourceMessageIds);

  // Backfill vendor sourceMessageIds from the cache. The model is
  // inconsistent about citing every vendor email; the canonical
  // GMAIL#VENDOR#<slug>#<date>#<id> index gives us a deterministic source
  // of truth. We prepend up to 6 recent cached ids for any vendor that
  // came back with fewer than 3 valid ids — keeping any model-cited ids
  // first so the most relevant threads (per the model) lead.
  if (safe.vendors && safe.vendors.length > 0) {
    const since = new Date(Date.now() - safe.rangeDays * 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    await Promise.all(
      safe.vendors.map(async (v) => {
        if ((v.sourceMessageIds?.length ?? 0) >= 3) return;
        const brand = (v.name ?? '').trim();
        if (!brand) return;
        // The model sometimes lists a vendor as having activity even when
        // the strict analysis window is empty (it carried context from the
        // seed snippets or older mail). Try the analysis window first, then
        // fall back to the last 180 days if we got nothing — it's still
        // useful to give the user *something* to click into.
        const fetchIds = async (
          brandQuery: string,
          sinceDate: string
        ): Promise<string[]> => {
          try {
            const res = await cacheQuery({
              vendor: brandQuery,
              since: sinceDate,
              limit: 6,
            });
            return res.rows.map((r) => r.id).filter(isLikelyGmailId);
          } catch (err) {
            console.warn(
              `vendor backfill failed for ${brandQuery} (since=${sinceDate}): ${(err as Error).message}`
            );
            return [];
          }
        };
        // The model can return composite labels like "Naot / Yaleet".
        // Try the full label first; if nothing comes back, try each token.
        const candidateBrands: string[] = [brand];
        const tokens = brand
          .split(/[\s/+,&·•|]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 3 && t.length <= 30 && /[a-z]/i.test(t));
        for (const t of tokens) {
          if (!candidateBrands.includes(t)) candidateBrands.push(t);
        }

        let cachedIds: string[] = [];
        const fallbackSince = new Date(Date.now() - 180 * 86400 * 1000)
          .toISOString()
          .slice(0, 10);
        for (const cand of candidateBrands) {
          cachedIds = await fetchIds(cand, since);
          if (cachedIds.length > 0) break;
          if (fallbackSince < since) {
            cachedIds = await fetchIds(cand, fallbackSince);
            if (cachedIds.length > 0) break;
          }
        }

        // Merge: keep model-cited ids first, then add fresh cached ids
        // we don't already have. Cap at 6 to keep the chip row tidy.
        const existing = new Set(v.sourceMessageIds ?? []);
        const merged = [...(v.sourceMessageIds ?? [])];
        for (const id of cachedIds) {
          if (merged.length >= 6) break;
          if (!existing.has(id)) {
            merged.push(id);
            existing.add(id);
          }
        }
        v.sourceMessageIds = merged;
      })
    );
  }

  // Backfill customer-inquiry sourceMessageId from the cache. The model
  // sometimes provides subject + from + date but not the actual id. We
  // resolve by querying the customer-kind partition for matching from,
  // then fall back to kb_semantic_search when the cited `from` is generic
  // ("Customer (unknown)", "A customer", etc.) or yields nothing.
  if (safe.customerInquiries && safe.customerInquiries.length > 0) {
    const isGenericFrom = (s: string): boolean => {
      const lower = s.toLowerCase().trim();
      if (!lower) return true;
      // No real email address present and looks like a placeholder
      const hasEmail = /[\w.+-]+@[\w.-]+/.test(lower);
      if (hasEmail) return false;
      return (
        lower.includes('unknown') ||
        lower.includes('placeholder') ||
        lower.includes('redacted') ||
        lower.includes('various') ||
        lower === 'customer' ||
        lower === 'a customer' ||
        lower.startsWith('customer (') ||
        lower.startsWith('customer -')
      );
    };

    await Promise.all(
      safe.customerInquiries.map(async (c) => {
        if (c.sourceMessageId && isLikelyGmailId(c.sourceMessageId)) return;
        const fromHeader = (c.from ?? '').trim();
        const subject = (c.subject ?? '').trim();
        const summary = (c.summary ?? '').trim();
        const dateOnly = (c.date ?? '').trim();
        if (!fromHeader && !subject && !summary) return;

        // Search a ~14-day window around the cited date if present, else
        // the last 60 days.
        let since: string;
        let until: string | undefined;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
          const d = new Date(dateOnly + 'T12:00:00Z');
          const before = new Date(d.getTime() - 7 * 86400 * 1000);
          const after = new Date(d.getTime() + 7 * 86400 * 1000);
          since = before.toISOString().slice(0, 10);
          until = after.toISOString().slice(0, 10);
        } else {
          since = new Date(Date.now() - 60 * 86400 * 1000)
            .toISOString()
            .slice(0, 10);
        }

        // First try: cache_query by sender (only useful when `from` is real).
        if (!isGenericFrom(fromHeader)) {
          try {
            const fromHint =
              fromHeader.match(/<([^>]+)>/)?.[1] ?? fromHeader;
            let res = await cacheQuery({
              kind: 'customer',
              from: fromHint,
              since,
              ...(until ? { until } : {}),
              limit: 5,
            });
            if (res.rows.length === 0) {
              res = await cacheQuery({
                from: fromHint,
                since,
                ...(until ? { until } : {}),
                limit: 5,
              });
            }
            const subjLower = subject.toLowerCase();
            const best =
              (subjLower
                ? res.rows.find((r) =>
                    (r.subject ?? '').toLowerCase().includes(subjLower.slice(0, 30))
                  )
                : null) ?? res.rows[0];
            if (best && isLikelyGmailId(best.id)) {
              c.sourceMessageId = best.id;
              return;
            }
          } catch (err) {
            console.warn(
              `customer-inquiry cache_query failed for ${fromHeader}: ${(err as Error).message}`
            );
          }
        }

        // Fallback: semantic search over message bodies. Use subject +
        // summary as the query — kb_semantic_search will find the actual
        // customer email even when the model reported a generic `from`.
        const query = [subject, summary].filter(Boolean).join(' — ').trim();
        if (!query) return;
        try {
          const hits = await vectorKbSearch(query, 8);
          // Prefer hits classified as customer-kind, then any non-vendor.
          const ranked = [
            ...hits.filter((h) => h.kind === 'customer'),
            ...hits.filter((h) => h.kind !== 'customer' && h.kind !== 'vendor'),
            ...hits,
          ];
          const seen = new Set<string>();
          for (const h of ranked) {
            if (seen.has(h.messageId)) continue;
            seen.add(h.messageId);
            if (isLikelyGmailId(h.messageId)) {
              c.sourceMessageId = h.messageId;
              // Also upgrade the displayed from/subject to the real ones
              // when the model provided a generic placeholder.
              if (isGenericFrom(fromHeader) && h.from) {
                c.from = h.from;
              }
              if (!subject && h.subject) {
                c.subject = h.subject;
              }
              break;
            }
          }
        } catch (err) {
          console.warn(
            `customer-inquiry kb_semantic_search failed: ${(err as Error).message}`
          );
        }
      })
    );
  }

  // Backfill follow-up sourceMessageIds via semantic search over the
  // cache. Follow-ups don't have a specific brand or sender, but they DO
  // have a title + "why" that's perfect for kb_semantic_search.
  if (safe.followUpsNeeded && safe.followUpsNeeded.length > 0) {
    await Promise.all(
      safe.followUpsNeeded.map(async (f) => {
        if ((f.sourceMessageIds?.length ?? 0) >= 1) return;
        const query = [f.title, f.why, f.suggestedAction]
          .filter(Boolean)
          .join(' — ')
          .trim();
        if (!query) return;
        try {
          const hits = await vectorKbSearch(query, 4);
          const cachedIds = hits.map((h) => h.messageId).filter(isLikelyGmailId);
          if (cachedIds.length === 0) return;
          const existing = new Set(f.sourceMessageIds ?? []);
          const merged = [...(f.sourceMessageIds ?? [])];
          for (const id of cachedIds) {
            if (merged.length >= 4) break;
            if (!existing.has(id)) {
              merged.push(id);
              existing.add(id);
            }
          }
          f.sourceMessageIds = merged;
        } catch (err) {
          console.warn(
            `follow-up backfill failed for "${f.title}": ${(err as Error).message}`
          );
        }
      })
    );
  }

  const allIds = new Set<string>();
  for (const e of safe.events ?? []) for (const id of e.sourceMessageIds ?? []) allIds.add(id);
  for (const v of safe.vendors ?? []) for (const id of v.sourceMessageIds ?? []) allIds.add(id);
  for (const inv of safe.invoices ?? []) if (inv.sourceMessageId) allIds.add(inv.sourceMessageId);
  for (const c of safe.customerInquiries ?? []) if (c.sourceMessageId) allIds.add(c.sourceMessageId);
  for (const f of safe.followUpsNeeded ?? []) for (const id of f.sourceMessageIds ?? []) allIds.add(id);
  if (allIds.size === 0) return;

  const map = await resolveThreadIds([...allIds]);
  for (const e of safe.events ?? []) {
    (e as { sourceThreadIds?: string[] }).sourceThreadIds =
      (e.sourceMessageIds ?? []).map((id) => map[id] ?? id);
  }
  for (const v of safe.vendors ?? []) {
    (v as { sourceThreadIds?: string[] }).sourceThreadIds =
      (v.sourceMessageIds ?? []).map((id) => map[id] ?? id);
  }
  for (const inv of safe.invoices ?? []) {
    if (inv.sourceMessageId) {
      (inv as { sourceThreadId?: string }).sourceThreadId =
        map[inv.sourceMessageId] ?? inv.sourceMessageId;
    }
  }
  for (const c of safe.customerInquiries ?? []) {
    if (c.sourceMessageId) {
      (c as { sourceThreadId?: string }).sourceThreadId =
        map[c.sourceMessageId] ?? c.sourceMessageId;
    }
  }
  for (const f of safe.followUpsNeeded ?? []) {
    (f as { sourceThreadIds?: string[] }).sourceThreadIds =
      (f.sourceMessageIds ?? []).map((id) => map[id] ?? id);
  }
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
  - kb_semantic_search(query, top_k?)      → semantic / fuzzy search over message bodies. Use this when the question is conceptual ("anyone complaining about fit", "emails about pricing concerns") and exact-match cache_query won't find it.

Tool selection rule of thumb:
  - Filter by vendor / sender / date / kind / known phrase  → cache_query
  - Concept, theme, or paraphrased meaning                   → kb_semantic_search
  - Quick coverage check                                     → cache_stats

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
              case 'kb_semantic_search': {
                const q = String(inp['query'] ?? '');
                const topK = Math.min(Number(inp['top_k']) || 8, 25);
                const hits = await vectorKbSearch(q, topK);
                result = JSON.stringify({ query: q, count: hits.length, hits });
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

// ── Daily Highlights ─────────────────────────────────────────────────
//
// A separate Bedrock pass (cheaper than full analyze) that produces a
// 3-section daily highlight: vendors, HQ/franchise network, customers.
// Uses cache + Tavily web search. Cached at sk=GMAIL#HIGHLIGHTS#LATEST
// with the same async self-invoke pattern as analyze.

const HIGHLIGHTS_SK = 'GMAIL#HIGHLIGHTS#LATEST';
const HIGHLIGHTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface HighlightItem {
  title: string;
  detail: string;
  whyItMatters?: string;
  sourceMessageIds?: string[];
  sourceUrls?: string[];
}

interface DailyHighlights {
  generatedAt: string;
  windowDays: number;
  vendors: HighlightItem[];
  network: { fromCorporate: HighlightItem[]; fromOtherStores: HighlightItem[] };
  customers: HighlightItem[];
  modelId: string;
}

interface CachedHighlights extends DailyHighlights {
  status?: 'ready' | 'running' | 'error';
  runStartedAt?: string;
  runEndedAt?: string;
  lastError?: string | null;
}

const HIGHLIGHTS_SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    vendors: {
      type: 'array',
      description:
        'Notable vendor activity in the window (new collections, backorders, co-op promos, rep visits, market shifts). 3-6 items max.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          whyItMatters: { type: 'string' },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
          sourceUrls: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'detail'],
      },
    },
    network: {
      type: 'object',
      properties: {
        fromCorporate: {
          type: 'array',
          description:
            'HQ communications: regional sales reports, monthly marketing minute, training calls, council voting, business plans, system maintenance, leadership announcements. 2-4 items.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              whyItMatters: { type: 'string' },
              sourceMessageIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'detail'],
          },
        },
        fromOtherStores: {
          type: 'array',
          description:
            'Activity in shared/group threads from sister Foot Solutions stores. 2-4 items.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              whyItMatters: { type: 'string' },
              sourceMessageIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'detail'],
          },
        },
      },
      required: ['fromCorporate', 'fromOtherStores'],
    },
    customers: {
      type: 'array',
      description:
        'Inbound customer threads in the window: appointment requests, complaints, fitting questions, follow-ups owed. 3-6 items.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          whyItMatters: { type: 'string' },
          sourceMessageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['vendors', 'network', 'customers'],
} as const;

const HIGHLIGHTS_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'cache_query',
      description:
        'Query the Gmail cache. Use kind=vendor / corporate / franchise / customer with since/until to scope to the window.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vendor: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['invoice', 'vendor', 'customer', 'corporate', 'franchise', 'internal'],
            },
            since: { type: 'string' },
            until: { type: 'string' },
            from: { type: 'string' },
            text: { type: 'string' },
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
      description: 'Read full body of a cached email.',
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
      name: 'web_search',
      description:
        "Tavily web search. Use SPARINGLY (max 3 calls per run) to enrich vendor highlights with recent industry news. Examples: 'Brooks Running Q2 2026 news', 'Hoka Bondi 9 launch'. Default topic=news, days=7.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            days: { type: 'number', description: 'Restrict to last N days (default 7).' },
            maxResults: { type: 'number' },
          },
          required: ['query'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'submit_highlights',
      description:
        'Submit your final highlights structure. Call this exactly once when finished.',
      inputSchema: {
        json: HIGHLIGHTS_SUBMIT_SCHEMA as unknown as Record<string, never>,
      },
    },
  },
];

function buildHighlightsSystemPrompt(windowDays: number, today: string): string {
  return `You are the Daily Highlights assistant for the new owner of Foot Solutions Flower Mound.
Today's date (Central Time): ${today}
Window: last ${windowDays} days.

Your job: produce a TIGHT daily highlights digest with three sections — Vendors, Foot Solutions Network (HQ + sister stores), and Customers. The owner glances at this between fittings, so be concise.

Tools:
  - cache_query — your primary tool. The cache classifies messages as kind=vendor, corporate, franchise, customer, invoice, or internal.
  - cache_read — fetch a body if you need actual content (prices, dates, contacts).
  - web_search — Tavily news search. Use AT MOST 3 times, only for vendor news worth flagging (a brand launch, a market story, a relevant industry shift). Skip if nothing reaches that bar.
  - submit_highlights — your FINAL action. Must be called exactly once.

Hard rules:
- Be specific. "Brooks rep emailed about Adrenaline GTS 24 backorder until 6/15" beats "Brooks had inventory updates."
- Include sourceMessageIds for every email-derived item so the owner can click through. Include sourceUrls for any web-search-derived items.
- CRITICAL: every sourceMessageIds string MUST be an EXACT id copied verbatim from a cache_query / cache_read result (16-char lowercase hex like "19e4c8a0798d5a47"). NEVER invent placeholder IDs like "msg-1" or "seed-brand-01". If you don't have a real id for an item, leave the array empty rather than fabricate.
- whyItMatters is one short sentence on impact (revenue, deadline, customer experience). Skip if obvious.
- If a section has no signal, return an empty array — do not pad.
- Cap each list to 3-6 items. Quality > quantity.
- HQ classification: corporate = leadership/ops/marketing at footsolutions.com (Taylor, John, Jordan, Don, Gary, Marek, etc.) and HQ-affiliated systems (QuickBooks, Voxelcare). Franchise = sister stores like katy@, greenville@, acworth@, etc.
- Skip noise: routine OOO replies, automated calendar invites, marketing list footers.

Workflow (be efficient):
1. cache_query({ kind: 'vendor', since: <window-start> }) — get vendor activity
2. cache_query({ kind: 'corporate', since: <window-start> }) — get HQ
3. cache_query({ kind: 'franchise', since: <window-start> }) — get sister stores
4. cache_query({ kind: 'customer', since: <window-start> }) — get customer threads
5. Read 2-4 specific messages with cache_read for the most consequential items
6. Optional: 1-3 Tavily searches if a vendor has a noteworthy news angle
7. submit_highlights with all sections populated

By your 12th total tool call, submit_highlights MUST be next.`;
}

async function runDailyHighlights(): Promise<CachedHighlights> {
  // 48-hour window covers Sat→Tue cleanly given the store is closed Sun/Mon.
  const windowDays = 2;
  const today = ctDateStr();
  const since = ctDateStr(new Date(Date.now() - windowDays * 86400 * 1000));
  void since;

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          text: `Produce the daily highlights for ${today}. Window: messages with date >= ${ctDateStr(
            new Date(Date.now() - windowDays * 86400 * 1000)
          )}. Begin by querying the cache for each kind. Submit early.`,
        },
      ],
    },
  ];

  const MAX_ROUNDS = 18;
  let highlights: DailyHighlights['vendors'] extends unknown ? Partial<DailyHighlights> | null : null;
  highlights = null;
  let lastText: string | null = null;
  let webSearchCount = 0;
  const WEB_SEARCH_CAP = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: buildHighlightsSystemPrompt(windowDays, today) }],
        messages,
        toolConfig: { tools: HIGHLIGHTS_TOOLS },
        inferenceConfig: { maxTokens: 3000, temperature: 0.2 },
      })
    );
    const assistantContent = response.output?.message?.content ?? [];
    messages.push({ role: 'assistant', content: assistantContent as ContentBlock[] });

    const textBlk = assistantContent.find((b) => 'text' in b);
    if (textBlk && 'text' in textBlk && textBlk.text) lastText = textBlk.text;

    const stopReason = response.stopReason;

    if (stopReason === 'tool_use') {
      const toolBlocks = assistantContent.filter((b) => 'toolUse' in b);
      const results: ContentBlock[] = [];

      for (const block of toolBlocks) {
        if (!('toolUse' in block) || !block.toolUse) continue;
        const { toolUseId, name, input } = block.toolUse;
        const inp = (input ?? {}) as Record<string, unknown>;

        if (name === 'submit_highlights') {
          highlights = inp as Partial<DailyHighlights>;
          results.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify({ ok: true }) }],
              status: 'success',
            },
          });
        } else if (name === 'cache_query') {
          const r = await cacheQuery(inp as CachedQueryArgs);
          results.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify(r) }],
              status: 'success',
            },
          });
        } else if (name === 'cache_read') {
          const id = String(inp['id'] ?? '');
          const dateOnly = String(inp['dateOnly'] ?? '') || undefined;
          const m = await cacheRead(id, dateOnly);
          results.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify(m ?? { error: `Message ${id} not in cache` }) }],
              status: 'success',
            },
          });
        } else if (name === 'web_search') {
          if (webSearchCount >= WEB_SEARCH_CAP) {
            results.push({
              toolResult: {
                toolUseId: toolUseId ?? '',
                content: [
                  {
                    text: JSON.stringify({
                      error: 'Web search cap reached. Submit highlights with what you have.',
                    }),
                  },
                ],
                status: 'error',
              },
            });
          } else {
            webSearchCount++;
            try {
              const r = await tavilySearch(String(inp['query'] ?? ''), {
                topic: 'news',
                days: Math.min(Number(inp['days']) || 7, 30),
                maxResults: Math.min(Number(inp['maxResults']) || 5, 10),
                includeAnswer: true,
              });
              results.push({
                toolResult: {
                  toolUseId: toolUseId ?? '',
                  content: [{ text: JSON.stringify(r) }],
                  status: 'success',
                },
              });
            } catch (err) {
              results.push({
                toolResult: {
                  toolUseId: toolUseId ?? '',
                  content: [{ text: JSON.stringify({ error: (err as Error).message }) }],
                  status: 'error',
                },
              });
            }
          }
        } else {
          results.push({
            toolResult: {
              toolUseId: toolUseId ?? '',
              content: [{ text: JSON.stringify({ error: `unknown tool ${name}` }) }],
              status: 'error',
            },
          });
        }
      }

      messages.push({ role: 'user', content: results });
      if (highlights) break;
      continue;
    }

    break;
  }

  // Force-submit retry if needed — rebuild a clean messages array to avoid
  // orphan tool_use blocks from the main loop.
  if (!highlights) {
    console.warn('Highlights: model did not call submit_highlights. Forcing.');
    const forceMessages: Message[] = [
      {
        role: 'user',
        content: [
          {
            text: `Submit your final daily highlights NOW for the last ${windowDays} days. Empty arrays are fine for sections without signal. Call submit_highlights exactly once.${
              lastText ? `\n\nDraft you wrote: "${lastText.slice(0, 1500)}"` : ''
            }`,
          },
        ],
      },
    ];
    try {
      const r = await bedrockClient.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: buildHighlightsSystemPrompt(windowDays, today) }],
          messages: forceMessages,
          toolConfig: {
            tools: HIGHLIGHTS_TOOLS,
            toolChoice: { tool: { name: 'submit_highlights' } },
          },
          inferenceConfig: { maxTokens: 3000, temperature: 0.2 },
        })
      );
      const finalContent = r.output?.message?.content ?? [];
      const sb = finalContent.find(
        (b) => 'toolUse' in b && b.toolUse?.name === 'submit_highlights'
      );
      if (sb && 'toolUse' in sb && sb.toolUse) {
        highlights = sb.toolUse.input as Partial<DailyHighlights>;
      }
    } catch (err) {
      console.warn('Highlights force-submit failed:', (err as Error).message);
    }
  }

  // Last-resort fallback
  if (!highlights) {
    highlights = {
      vendors: [],
      network: { fromCorporate: [], fromOtherStores: [] },
      customers: [],
    };
  }

  const safe: CachedHighlights = {
    generatedAt: new Date().toISOString(),
    windowDays,
    vendors: Array.isArray(highlights.vendors) ? highlights.vendors : [],
    network: {
      fromCorporate: Array.isArray(highlights.network?.fromCorporate)
        ? highlights.network!.fromCorporate
        : [],
      fromOtherStores: Array.isArray(highlights.network?.fromOtherStores)
        ? highlights.network!.fromOtherStores
        : [],
    },
    customers: Array.isArray(highlights.customers) ? highlights.customers : [],
    modelId: MODEL_ID,
    status: 'ready',
    runEndedAt: new Date().toISOString(),
    lastError: null,
  };
  void lastText;

  // Resolve every messageId into a threadId so the UI's deep links work.
  await annotateHighlightsWithThreadIds(safe);

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: HIGHLIGHTS_SK, ...safe },
    })
  );
  return safe;
}

async function annotateHighlightsWithThreadIds(safe: CachedHighlights): Promise<void> {
  // Drop hallucinated IDs first
  for (const v of safe.vendors ?? []) v.sourceMessageIds = sanitizeIds(v.sourceMessageIds);
  for (const c of safe.customers ?? []) c.sourceMessageIds = sanitizeIds(c.sourceMessageIds);
  for (const n of safe.network?.fromCorporate ?? [])
    n.sourceMessageIds = sanitizeIds(n.sourceMessageIds);
  for (const n of safe.network?.fromOtherStores ?? [])
    n.sourceMessageIds = sanitizeIds(n.sourceMessageIds);

  const allIds = new Set<string>();
  for (const v of safe.vendors ?? []) for (const id of v.sourceMessageIds ?? []) allIds.add(id);
  for (const c of safe.customers ?? []) for (const id of c.sourceMessageIds ?? []) allIds.add(id);
  for (const n of safe.network?.fromCorporate ?? [])
    for (const id of n.sourceMessageIds ?? []) allIds.add(id);
  for (const n of safe.network?.fromOtherStores ?? [])
    for (const id of n.sourceMessageIds ?? []) allIds.add(id);
  if (allIds.size === 0) return;
  const map = await resolveThreadIds([...allIds]);
  const annotate = (item: HighlightItem) => {
    (item as { sourceThreadIds?: string[] }).sourceThreadIds =
      (item.sourceMessageIds ?? []).map((id) => map[id] ?? id);
  };
  safe.vendors.forEach(annotate);
  safe.customers.forEach(annotate);
  safe.network.fromCorporate.forEach(annotate);
  safe.network.fromOtherStores.forEach(annotate);
}

async function getCachedHighlights(): Promise<CachedHighlights | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: HIGHLIGHTS_SK } })
  );
  return ((r.Item as unknown) as CachedHighlights) ?? null;
}

async function markHighlightsRunning(): Promise<void> {
  const existing = (await getCachedHighlights()) ?? ({} as Partial<CachedHighlights>);
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: HIGHLIGHTS_SK,
        ...existing,
        status: 'running',
        runStartedAt: new Date().toISOString(),
        lastError: null,
      },
    })
  );
}

async function markHighlightsError(message: string): Promise<void> {
  const existing = (await getCachedHighlights()) ?? ({} as Partial<CachedHighlights>);
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: HIGHLIGHTS_SK,
        ...existing,
        status: 'error',
        runEndedAt: new Date().toISOString(),
        lastError: message,
      },
    })
  );
}

// ── Async run state ──────────────────────────────────────────────────
//
// "running" / "error" markers on the cached analysis row let the GET
// endpoint distinguish "still working" from "ready" from "failed".

interface AsyncInvokePayload {
  __mode: 'analyze' | 'highlights';
  days?: number;
}

async function markAnalysisRunning(days: number): Promise<void> {
  const existing = (await getCachedAnalysis()) ?? ({} as Partial<CachedAnalysis>);
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: ANALYSIS_SK,
        // Keep prior result fields so the UI can still render the last one
        // while the new run is in flight.
        ...existing,
        status: 'running',
        rangeDaysRequested: days,
        runStartedAt: new Date().toISOString(),
        lastError: null,
      },
    })
  );
}

async function markAnalysisError(days: number, message: string): Promise<void> {
  const existing = (await getCachedAnalysis()) ?? ({} as Partial<CachedAnalysis>);
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: ANALYSIS_SK,
        ...existing,
        status: 'error',
        rangeDaysRequested: days,
        lastError: message,
        runEndedAt: new Date().toISOString(),
      },
    })
  );
}

// ── Vendor account number discovery ──────────────────────────────────
//
// Scans the Gmail cache for each provided vendor brand, sends recent
// messages to Bedrock with a strict tool schema that asks for the vendor
// account number (if any). Auto-applies HIGH-confidence matches and
// returns MEDIUM-confidence matches as suggestions for the user to review.

interface DiscoveredAccount {
  vendorId: number;
  vendorName: string;
  accountNumber: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sourceMessageIds: string[];
}

interface DiscoveryResult {
  applied: DiscoveredAccount[];
  suggestions: DiscoveredAccount[];
  skipped: Array<{ vendorId: number; vendorName: string; reason: string }>;
  notFound: Array<{ vendorId: number; vendorName: string }>;
  totalScanned: number;
}

const ACCOUNT_DISCOVERY_TOOL: Tool = {
  toolSpec: {
    name: 'submit_account_number',
    description:
      'Submit the discovered vendor account number for the brand the user asked about. Call this exactly once per vendor when finished. If you cannot find a clear account number, set accountNumber to an empty string and confidence to "low".',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          accountNumber: {
            type: 'string',
            description:
              'The account number / customer number the vendor uses to identify Foot Solutions Flower Mound. Examples: "97378", "FS-12345", "CUST-FOOT-001". Empty string if none found.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'high = explicit "Account #" or "Customer #" label with a clear value. medium = inferred from a recurring identifier in invoice headers / signatures. low = guess or no clear evidence.',
          },
          evidence: {
            type: 'string',
            description:
              'One short sentence quoting or paraphrasing where you saw the number (e.g. "Invoice header reads Account: 97378", or "Multiple invoices have customer code FS-1138 in the PDF subject line").',
          },
          sourceMessageIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'IDs of the cached messages where the number appears. Copy verbatim from the cache_query / cache_read results. Empty array if you found nothing.',
          },
        },
        required: ['accountNumber', 'confidence', 'evidence', 'sourceMessageIds'],
      } as unknown as Record<string, never>,
    },
  },
};

function isLikelyAccountNumber(s: string): boolean {
  const v = (s ?? '').trim();
  if (v.length < 3 || v.length > 30) return false;
  // Must contain at least one digit and only allowed chars
  if (!/\d/.test(v)) return false;
  if (!/^[A-Za-z0-9._\-/#]+$/.test(v)) return false;
  // Reject obvious phone numbers (10-11 digits, no other separators)
  const digitsOnly = v.replace(/\D/g, '');
  if (/^[A-Za-z]{0,2}\d{10,11}$/.test(v) && digitsOnly.length >= 10) return false;
  // Reject obvious emails / URLs
  if (v.includes('@') || v.includes('://')) return false;
  return true;
}

async function discoverOneVendorAccount(
  vendorName: string,
  vendorId: number
): Promise<Omit<DiscoveredAccount, 'vendorId' | 'vendorName'> | null> {
  // Pull up to 12 recent cached emails for this vendor (any kind, last
  // 365 days). We use the canonical metadata + body bodies.
  const since = new Date(Date.now() - 365 * 86400 * 1000).toISOString().slice(0, 10);
  const queryRes = await cacheQuery({ vendor: vendorName, since, limit: 12 });
  if (queryRes.rows.length === 0) return null;

  // Fetch full bodies for the top 6 — enough context for a quick Haiku scan.
  const bodies = await Promise.all(
    queryRes.rows.slice(0, 6).map(async (r) => {
      try {
        const full = await cacheRead(r.id, r.dateOnly);
        return {
          id: r.id,
          dateOnly: r.dateOnly,
          from: r.from,
          subject: r.subject,
          bodyText: (full?.bodyText ?? r.snippet ?? '').slice(0, 2500),
        };
      } catch {
        return {
          id: r.id,
          dateOnly: r.dateOnly,
          from: r.from,
          subject: r.subject,
          bodyText: (r.snippet ?? '').slice(0, 1000),
        };
      }
    })
  );

  const corpus = bodies
    .map(
      (b, i) =>
        `[${i + 1}] id=${b.id} | ${b.dateOnly} | from: ${b.from} | subject: ${b.subject}\n${b.bodyText}`
    )
    .join('\n\n---\n\n');

  const systemPrompt = `You are an account-number extraction tool for a small footwear retail store (Foot Solutions Flower Mound).
Your job: scan the provided emails from a single vendor and find the store's account / customer number with that vendor.

What counts as an account number:
- Explicit labels: "Account #", "Customer #", "Cust #", "Account ID", "Account No.", "Customer ID", "Acct #"
- Numbers in invoice headers next to "BILL TO: Foot Solutions Flower Mound"
- Recurring vendor-side identifiers that appear on every invoice for THIS store (not invoice numbers, not order numbers, not PO numbers)

What does NOT count:
- Phone numbers, fax numbers
- Invoice numbers, order numbers, tracking numbers, PO numbers
- Email addresses, URLs
- Tax IDs, EINs (those are for the store)
- Random numbers in product SKUs

Rules:
- If multiple candidates exist, pick the one labeled most clearly as "Account" or "Customer" number.
- If you find nothing clearly identifiable, return accountNumber="" with confidence="low".
- NEVER invent or guess. If unsure, pick "low" confidence.
- Always call submit_account_number exactly once.`;

  const userPrompt = `Vendor: ${vendorName}

Emails from this vendor (most recent first):

${corpus}

Find the account number Foot Solutions has with ${vendorName} and call submit_account_number.`;

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      toolConfig: {
        tools: [ACCOUNT_DISCOVERY_TOOL],
        toolChoice: { tool: { name: 'submit_account_number' } },
      },
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    })
  );

  const content = response.output?.message?.content ?? [];
  const submit = content.find(
    (b) => 'toolUse' in b && b.toolUse?.name === 'submit_account_number'
  );
  if (!submit || !('toolUse' in submit) || !submit.toolUse) return null;

  const input = (submit.toolUse.input ?? {}) as {
    accountNumber?: string;
    confidence?: 'high' | 'medium' | 'low';
    evidence?: string;
    sourceMessageIds?: string[];
  };

  const accountNumber = (input.accountNumber ?? '').trim();
  if (!accountNumber || !isLikelyAccountNumber(accountNumber)) return null;

  return {
    accountNumber,
    confidence: input.confidence ?? 'low',
    evidence: (input.evidence ?? '').slice(0, 240),
    sourceMessageIds: (input.sourceMessageIds ?? []).filter(isLikelyGmailId).slice(0, 4),
  };
}

async function discoverVendorAccounts(
  vendors: Array<{ id: number; name: string }>,
  existingAccounts: Record<string, string>
): Promise<DiscoveryResult> {
  const applied: DiscoveredAccount[] = [];
  const suggestions: DiscoveredAccount[] = [];
  const skipped: Array<{ vendorId: number; vendorName: string; reason: string }> = [];
  const notFound: Array<{ vendorId: number; vendorName: string }> = [];

  // Cap to keep per-run cost bounded and stay under API GW timeout.
  const MAX_VENDORS = 60;
  const todo = vendors.slice(0, MAX_VENDORS);

  // Process in parallel chunks of 4 to balance speed vs Bedrock throttling.
  const CHUNK = 4;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (v) => {
        const name = (v.name ?? '').trim();
        if (!name) {
          skipped.push({ vendorId: v.id, vendorName: name, reason: 'no name' });
          return;
        }
        const existing = (existingAccounts[String(v.id)] ?? '').trim();
        if (existing) {
          skipped.push({
            vendorId: v.id,
            vendorName: name,
            reason: 'already set',
          });
          return;
        }
        try {
          const res = await discoverOneVendorAccount(name, v.id);
          if (!res) {
            notFound.push({ vendorId: v.id, vendorName: name });
            return;
          }
          const record: DiscoveredAccount = {
            vendorId: v.id,
            vendorName: name,
            ...res,
          };
          if (res.confidence === 'high') {
            applied.push(record);
          } else if (res.confidence === 'medium') {
            suggestions.push(record);
          } else {
            notFound.push({ vendorId: v.id, vendorName: name });
          }
        } catch (err) {
          console.warn(
            `account discovery failed for ${name}: ${(err as Error).message}`
          );
          skipped.push({
            vendorId: v.id,
            vendorName: name,
            reason: (err as Error).message,
          });
        }
      })
    );
  }

  return {
    applied,
    suggestions,
    skipped,
    notFound,
    totalScanned: todo.length,
  };
}

// ── Route dispatch ───────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer | AsyncInvokePayload
): Promise<APIGatewayProxyResultV2 | { ok: boolean }> => {
  // Async self-invocation path — bypasses API Gateway's 30s timeout.
  if (typeof event === 'object' && event !== null && '__mode' in event && event.__mode === 'analyze') {
    const days = Math.min(Math.max(Number(event.days) || 14, 1), 180);
    try {
      const fresh = await runAnalyze(days);
      // Mark run complete by overwriting the row with the fresh analysis +
      // status=ready (runAnalyze already saves the data; just patch status).
      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            userId: OWNER_USER_ID,
            sk: ANALYSIS_SK,
            ...fresh,
            status: 'ready',
            runEndedAt: new Date().toISOString(),
            lastError: null,
          },
        })
      );
      return { ok: true };
    } catch (err) {
      console.error('async analyze error:', (err as Error).message, (err as Error).stack);
      await markAnalysisError(days, (err as Error).message);
      return { ok: false };
    }
  }

  if (typeof event === 'object' && event !== null && '__mode' in event && event.__mode === 'highlights') {
    try {
      await runDailyHighlights();
      return { ok: true };
    } catch (err) {
      console.error('async highlights error:', (err as Error).message, (err as Error).stack);
      await markHighlightsError((err as Error).message);
      return { ok: false };
    }
  }

  const apiEvent = event as APIGatewayProxyEventV2WithJWTAuthorizer;
  const route = apiEvent.routeKey;

  try {
    if (route === 'POST /gmail/analyze') {
      let body: { days?: number; refresh?: boolean } = {};
      try {
        body = JSON.parse(apiEvent.body ?? '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const days = Math.min(Math.max(Number(body.days) || 14, 1), 180);
      const refresh = !!body.refresh;

      const cached = await getCachedAnalysis();

      // Fresh enough to serve directly?
      if (
        !refresh &&
        cached &&
        (cached as Partial<CachedAnalysis> & { status?: string }).status !== 'running' &&
        cached.rangeDays === days &&
        cached.generatedAt &&
        Date.now() - new Date(cached.generatedAt).getTime() < ANALYSIS_CACHE_TTL_MS
      ) {
        return json(200, { ...cached, status: 'ready', fromCache: true });
      }

      // Already running? Don't kick off a duplicate.
      if (
        cached &&
        (cached as Partial<CachedAnalysis> & { status?: string }).status === 'running'
      ) {
        const startedAt = (cached as Partial<CachedAnalysis> & { runStartedAt?: string })
          .runStartedAt;
        // If the prior run is older than 6 minutes, assume it died and start fresh.
        const stalled =
          startedAt && Date.now() - new Date(startedAt).getTime() > 6 * 60 * 1000;
        if (!stalled) {
          return json(202, {
            status: 'running',
            runStartedAt: startedAt,
            message: 'Analysis already in progress.',
          });
        }
      }

      // Mark running and fire-and-forget self-invoke.
      await markAnalysisRunning(days);
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: SELF_FUNCTION_NAME,
          InvocationType: 'Event', // async — returns immediately
          Payload: Buffer.from(
            JSON.stringify({ __mode: 'analyze', days } satisfies AsyncInvokePayload)
          ),
        })
      );

      return json(202, {
        status: 'running',
        runStartedAt: new Date().toISOString(),
        message: 'Analysis started. Poll GET /gmail/analyze for the result.',
      });
    }

    if (route === 'GET /gmail/analyze') {
      const cached = await getCachedAnalysis();
      if (!cached) {
        return json(404, { status: 'none', error: 'No analysis cached yet' });
      }
      const status =
        (cached as Partial<CachedAnalysis> & { status?: string }).status ?? 'ready';
      // If we have a usable analysis, return it regardless of status so the
      // UI can show last-good while a new run is in flight.
      return json(200, { ...cached, status, fromCache: true });
    }

    if (route === 'POST /gmail/discover-vendor-accounts') {
      let body: { vendors?: Array<{ id: number; name: string }>; existingAccounts?: Record<string, string> } = {};
      try {
        body = JSON.parse(apiEvent.body ?? '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const vendors = Array.isArray(body.vendors) ? body.vendors : [];
      if (vendors.length === 0) {
        return json(400, { error: 'vendors array is required' });
      }
      const existingAccounts = body.existingAccounts ?? {};
      const result = await discoverVendorAccounts(vendors, existingAccounts);
      return json(200, result);
    }

    if (route === 'POST /gmail/chat') {
      let body: { messages?: ChatMessageInput[] };
      try {
        body = JSON.parse(apiEvent.body ?? '{}');
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

    if (route === 'POST /pos/daily-highlights') {
      let body: { refresh?: boolean } = {};
      try {
        body = JSON.parse(apiEvent.body ?? '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body' });
      }
      const refresh = !!body.refresh;
      const cached = await getCachedHighlights();

      if (
        !refresh &&
        cached &&
        cached.status !== 'running' &&
        cached.generatedAt &&
        Date.now() - new Date(cached.generatedAt).getTime() < HIGHLIGHTS_CACHE_TTL_MS
      ) {
        return json(200, { ...cached, status: 'ready', fromCache: true });
      }

      if (cached && cached.status === 'running') {
        const startedAt = cached.runStartedAt;
        const stalled =
          startedAt && Date.now() - new Date(startedAt).getTime() > 6 * 60 * 1000;
        if (!stalled) {
          return json(202, { status: 'running', runStartedAt: startedAt });
        }
      }

      await markHighlightsRunning();
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: SELF_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({ __mode: 'highlights' } satisfies AsyncInvokePayload)
          ),
        })
      );

      return json(202, {
        status: 'running',
        runStartedAt: new Date().toISOString(),
        message: 'Highlights generation started.',
      });
    }

    if (route === 'GET /pos/daily-highlights') {
      const cached = await getCachedHighlights();
      if (!cached) {
        return json(404, { status: 'none', error: 'No highlights yet.' });
      }
      return json(200, { ...cached, status: cached.status ?? 'ready', fromCache: true });
    }

    return json(404, { error: `Unknown route ${route}` });
  } catch (err) {
    console.error('gmail-analysis error:', (err as Error).message, (err as Error).stack);
    return json(500, { error: (err as Error).message });
  }
};
