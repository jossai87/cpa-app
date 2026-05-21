/**
 * Gmail Sync Lambda — backfill + incremental sync of the owner's Gmail
 * inbox into DynamoDB. Lets the chatbot/analysis tools query a fast local
 * cache instead of hitting Gmail every turn.
 *
 * Modes (chosen via the event payload):
 *   { mode: 'backfill', months?: 6 }       — bulk pull a date window
 *   { mode: 'incremental' }                — pull yesterday + today (cron)
 *   { mode: 'range', after: 'YYYY-MM-DD',
 *                    before: 'YYYY-MM-DD' } — explicit date window
 *
 * Triggers:
 *   - EventBridge cron (daily at 1am Central → 06:00 UTC)
 *   - On-demand: API Gateway POST /gmail/sync (proxied through this fn)
 *   - One-time backfill: invoke directly with { mode: 'backfill' }
 *
 * DynamoDB layout (single-table, no GSIs needed):
 *   PK: userId (owner)
 *   SK shapes — one canonical item plus 3 tiny pointer rows per message:
 *     GMAIL#MSG#<YYYY-MM-DD>#<id>                  ← canonical, full payload
 *     GMAIL#THREAD#<threadId>#<YYYY-MM-DD>#<id>    ← thread index pointer
 *     GMAIL#VENDOR#<brand>#<YYYY-MM-DD>#<id>       ← vendor index pointer
 *     GMAIL#KIND#<kind>#<YYYY-MM-DD>#<id>          ← kind index pointer
 *     GMAIL#SYNC#STATE                              ← bookkeeping (cursor, lastRunAt)
 *
 * TTL: every row carries a `ttl` epoch-seconds attribute set to 365 days
 *      from the message date, so the table self-prunes the rolling window.
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { searchEmails, getMessage } from '../gmail/client';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const STATE_SK = 'GMAIL#SYNC#STATE';
const BODY_CAP_BYTES = 6 * 1024; // 6 KB cap on bodyText
const TTL_DAYS = 365;
const MAX_PER_PAGE = 50;
const HARD_PER_RUN_CAP = 1500; // safety cap on a single Lambda run

// ── Vendor brand list — used for cheap signal extraction at write time ──
const VENDOR_BRANDS = [
  'Brooks',
  'Dansko',
  'Aetrex',
  'Hoka',
  'OluKai',
  'Drew',
  'Saucony',
  'Vionic',
  'Mephisto',
  'Apex',
  'Naot',
  'Sanita',
  'Feetures',
  'Yaleet',
  'Finn Comfort',
  'Rockport',
  'PW Minor',
];

// ── Utility functions ────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function isoDateOnly(iso: string): string {
  // 2026-05-21T20:27:43.000Z → 2026-05-21
  return iso.slice(0, 10);
}

function sanitizeBrand(b: string): string {
  return b.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectVendorBrand(text: string): string | null {
  const lower = text.toLowerCase();
  for (const brand of VENDOR_BRANDS) {
    if (lower.includes(brand.toLowerCase())) return brand;
  }
  return null;
}

const VENDOR_DOMAINS = [
  'brooksrunning.com',
  'dansko.com',
  'aetrex.com',
  'hoka.com',
  'olukai.com',
  'drewshoe.com',
  'saucony.com',
  'vionicshoes.com',
  'mephisto.com',
  'apexfoot.com',
  'naotusa.com',
  'sanita.com',
  'feetures.com',
  'yaleet.net',
  'finncomfort.com',
  'rockport.com',
  'pwminor.com',
];

function extractEmailDomain(fromHeader: string): string | null {
  const m = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/([\w.+-]+@[\w.-]+)/);
  if (!m) return null;
  const email = (m[1] ?? '').trim();
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

const OWNER_EMAIL_DOMAIN = 'footsolutions.com';

function isVendorDomain(domain: string | null): boolean {
  if (!domain) return false;
  return VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

function classifyKind(args: {
  fromHeader: string;
  toHeader: string;
  subject: string;
  body: string;
  vendorBrand: string | null;
}): 'invoice' | 'vendor' | 'customer' | 'internal' | null {
  const subj = args.subject.toLowerCase();
  const body = args.body.toLowerCase();
  const fromDomain = extractEmailDomain(args.fromHeader);
  const isFromOwner = fromDomain === OWNER_EMAIL_DOMAIN;
  const isFromVendor = isVendorDomain(fromDomain) || args.vendorBrand !== null;

  // Invoice signals — strongest, check first
  const invoiceRe =
    /\binvoice\b|\bamount due\b|\bpayment due\b|\bbalance due\b|\binvoice #|\bremittance\b|\bpayment reminder\b/;
  if (invoiceRe.test(subj) || invoiceRe.test(body)) return 'invoice';

  // Vendor: from a known vendor domain or mentions a brand
  if (isFromVendor) return 'vendor';

  // Internal: from the store's own domain
  if (isFromOwner) return 'internal';

  // Customer: short, personal, mentions appointments / fitting / questions
  const customerRe =
    /\bappointment\b|\bfitting\b|\bquestion about\b|\bcan you help\b|\bcan i\b|\bdo you\b/;
  if (customerRe.test(subj) || customerRe.test(body.slice(0, 800))) return 'customer';

  return null;
}

function ttlEpochSecs(messageDateIso: string): number {
  const t = new Date(messageDateIso).getTime();
  if (isNaN(t)) return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  return Math.floor(t / 1000) + TTL_DAYS * 86400;
}

// ── Sync state bookkeeping ───────────────────────────────────────────

interface SyncState {
  lastRunAt: string;
  lastBackfillStart?: string | null;
  lastBackfillEnd?: string | null;
  lastBackfillTotal?: number;
  lastIncrementalAdded?: number;
  totalCachedEstimate?: number;
  message?: string;
}

async function loadState(): Promise<SyncState | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: STATE_SK } })
  );
  return ((r.Item as unknown) as SyncState) ?? null;
}

async function saveState(patch: Partial<SyncState>): Promise<void> {
  const existing = (await loadState()) ?? ({} as SyncState);
  const next: SyncState = { ...existing, ...patch, lastRunAt: new Date().toISOString() };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: STATE_SK, ...next },
    })
  );
}

// ── Write a message + its index pointers ─────────────────────────────

interface CachedMessage {
  id: string;
  threadId: string;
  date: string;
  dateOnly: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyTruncated: boolean;
  vendorBrand: string | null;
  kind: 'invoice' | 'vendor' | 'customer' | 'internal' | null;
  hasAttachment: boolean;
  ttl: number;
}

async function writeMessage(msg: CachedMessage): Promise<void> {
  const items: Array<{ PutRequest: { Item: Record<string, unknown> } }> = [];
  const base = {
    userId: OWNER_USER_ID,
    ttl: msg.ttl,
    id: msg.id,
    threadId: msg.threadId,
    date: msg.date,
    dateOnly: msg.dateOnly,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    snippet: msg.snippet,
    vendorBrand: msg.vendorBrand,
    kind: msg.kind,
    hasAttachment: msg.hasAttachment,
  };

  // Canonical row — only place the full body lives
  items.push({
    PutRequest: {
      Item: {
        ...base,
        sk: `GMAIL#MSG#${msg.dateOnly}#${msg.id}`,
        bodyText: msg.bodyText,
        bodyTruncated: msg.bodyTruncated,
      },
    },
  });

  // Thread pointer (always)
  items.push({
    PutRequest: {
      Item: {
        ...base,
        sk: `GMAIL#THREAD#${msg.threadId}#${msg.dateOnly}#${msg.id}`,
      },
    },
  });

  // Vendor pointer (if a brand was detected)
  if (msg.vendorBrand) {
    items.push({
      PutRequest: {
        Item: {
          ...base,
          sk: `GMAIL#VENDOR#${sanitizeBrand(msg.vendorBrand)}#${msg.dateOnly}#${msg.id}`,
        },
      },
    });
  }

  // Kind pointer (if classified)
  if (msg.kind) {
    items.push({
      PutRequest: {
        Item: {
          ...base,
          sk: `GMAIL#KIND#${msg.kind}#${msg.dateOnly}#${msg.id}`,
        },
      },
    });
  }

  // BatchWriteItem max 25 per call — chunk if needed
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let attempt = 0;
    let unprocessed: typeof chunk = chunk;
    while (unprocessed.length > 0 && attempt < 5) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: unprocessed } })
      );
      unprocessed =
        ((res.UnprocessedItems?.[TABLE_NAME] as unknown) as typeof chunk) ?? [];
      if (unprocessed.length > 0) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
      attempt++;
    }
    if (unprocessed.length > 0) {
      console.warn(`Failed to write ${unprocessed.length} items for msg ${msg.id}`);
    }
  }
}

// ── Pagination helper using Gmail search syntax ──────────────────────
//
// Gmail's REST API supports a single-page list call that returns up to
// `maxResults` ids and a `nextPageToken`. The lambda/gmail/client.ts
// `searchEmails()` helper does one page only — wrap it for pagination.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = 'us-east-1';
const sm = new SecretsManagerClient({ region: REGION });
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function loadJsonSecret<T>(name: string): Promise<T> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`);
  return JSON.parse(res.SecretString) as T;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  const [client, tokens] = await Promise.all([
    loadJsonSecret<{ client_id: string; client_secret: string }>(
      'foot-solutions/gmail/oauth-client'
    ),
    loadJsonSecret<{ refresh_token: string }>('foot-solutions/gmail/refresh-token'),
  ]);
  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok)
    throw new Error(`Failed to refresh access token: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

interface GmailListPage {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

async function listMessagesPage(query: string, pageToken?: string): Promise<GmailListPage> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ q: query, maxResults: String(MAX_PER_PAGE) });
  if (pageToken) params.set('pageToken', pageToken);
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Gmail list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GmailListPage;
}

// ── Date helpers ─────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateAgoStr(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Convert YYYY-MM-DD to Gmail's expected YYYY/MM/DD. */
function gmailDate(s: string): string {
  return s.replace(/-/g, '/');
}

// ── Main sync routine ────────────────────────────────────────────────

interface SyncResult {
  mode: string;
  query: string;
  messagesSeen: number;
  messagesWritten: number;
  messagesSkipped: number;
  durationMs: number;
  truncated: boolean;
}

async function runSync(query: string, mode: string): Promise<SyncResult> {
  const t0 = Date.now();
  let pageToken: string | undefined;
  let seen = 0;
  let written = 0;
  let skipped = 0;
  let truncated = false;

  while (true) {
    const page = await listMessagesPage(query, pageToken);
    const ids = (page.messages ?? []).map((m) => m.id);
    seen += ids.length;

    // Look up each id (skip ones we already have)
    for (const id of ids) {
      if (written + skipped >= HARD_PER_RUN_CAP) {
        truncated = true;
        break;
      }
      try {
        // Cheap probe: does the canonical row exist? If yes, skip.
        // We don't know the date yet, so probe by listing a 1-element
        // begins_with on the id suffix is overkill. Simpler: fetch the
        // message, derive the dateOnly, then GetItem the canonical key.
        const detailed = await getMessage(id, BODY_CAP_BYTES);
        const dateOnly = isoDateOnly(detailed.date);
        const existing = await docClient.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: { userId: OWNER_USER_ID, sk: `GMAIL#MSG#${dateOnly}#${id}` },
          })
        );
        if (existing.Item) {
          skipped++;
          continue;
        }

        const headerForBrand = `${detailed.from} ${detailed.subject} ${detailed.snippet}`;
        const vendorBrand = detectVendorBrand(headerForBrand);
        const kind = classifyKind({
          fromHeader: detailed.from,
          toHeader: detailed.to,
          subject: detailed.subject,
          body: detailed.body,
          vendorBrand,
        });

        const cached: CachedMessage = {
          id: detailed.id,
          threadId: detailed.threadId,
          date: detailed.date,
          dateOnly,
          from: detailed.from,
          to: detailed.to,
          subject: detailed.subject,
          snippet: detailed.snippet,
          bodyText: detailed.body,
          bodyTruncated: detailed.truncated,
          vendorBrand,
          kind,
          hasAttachment: false, // Not extracted yet — could add later via parts walk
          ttl: ttlEpochSecs(detailed.date),
        };

        await writeMessage(cached);
        written++;
      } catch (err) {
        console.warn(`Failed to sync ${id}: ${(err as Error).message}`);
      }
    }

    if (truncated) break;
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  return {
    mode,
    query,
    messagesSeen: seen,
    messagesWritten: written,
    messagesSkipped: skipped,
    durationMs: Date.now() - t0,
    truncated,
  };
}

// ── Public modes ─────────────────────────────────────────────────────

async function backfill(months: number): Promise<SyncResult> {
  const after = dateAgoStr(months * 30);
  const before = todayStr();
  const query = `after:${gmailDate(after)} before:${gmailDate(before)} -category:promotions -category:social`;
  const result = await runSync(query, 'backfill');
  await saveState({
    lastBackfillStart: after,
    lastBackfillEnd: before,
    lastBackfillTotal: result.messagesWritten,
    message: result.truncated
      ? `Backfill capped at ${HARD_PER_RUN_CAP} messages — re-invoke to continue.`
      : `Backfill complete: ${result.messagesWritten} new, ${result.messagesSkipped} already cached.`,
  });
  return result;
}

async function incremental(): Promise<SyncResult> {
  // Pull the last 2 days to be safe across timezone seams + late-arriving mail
  const after = dateAgoStr(2);
  const query = `after:${gmailDate(after)} -category:promotions -category:social`;
  const result = await runSync(query, 'incremental');
  await saveState({
    lastIncrementalAdded: result.messagesWritten,
    message: `Incremental sync added ${result.messagesWritten} message(s).`,
  });
  return result;
}

async function rangeSync(after: string, before: string): Promise<SyncResult> {
  const query = `after:${gmailDate(after)} before:${gmailDate(before)} -category:promotions -category:social`;
  const result = await runSync(query, 'range');
  return result;
}

// ── Lambda entry — supports both EventBridge and API Gateway events ──

interface EventBridgeInvoke {
  mode?: 'backfill' | 'incremental' | 'range';
  months?: number;
  after?: string;
  before?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer | EventBridgeInvoke
): Promise<APIGatewayProxyResultV2 | SyncResult> => {
  // Detect which kind of event
  const isApiEvent =
    typeof event === 'object' &&
    event !== null &&
    'routeKey' in event &&
    typeof (event as APIGatewayProxyEventV2WithJWTAuthorizer).routeKey === 'string';

  let mode: 'backfill' | 'incremental' | 'range' = 'incremental';
  let months = 6;
  let after: string | undefined;
  let before: string | undefined;

  if (isApiEvent) {
    const apiEvent = event as APIGatewayProxyEventV2WithJWTAuthorizer;
    let body: EventBridgeInvoke = {};
    try {
      body = JSON.parse(apiEvent.body ?? '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
    if (body.mode) mode = body.mode;
    if (body.months) months = body.months;
    if (body.after) after = body.after;
    if (body.before) before = body.before;
  } else {
    const ebEvent = event as EventBridgeInvoke;
    if (ebEvent.mode) mode = ebEvent.mode;
    if (ebEvent.months) months = ebEvent.months;
    if (ebEvent.after) after = ebEvent.after;
    if (ebEvent.before) before = ebEvent.before;
  }

  try {
    let result: SyncResult;
    if (mode === 'backfill') {
      result = await backfill(Math.min(months, 12));
    } else if (mode === 'range') {
      if (!after || !before) {
        const err = { error: 'mode=range requires after and before YYYY-MM-DD' };
        return isApiEvent ? json(400, err) : (err as unknown as SyncResult);
      }
      result = await rangeSync(after, before);
    } else {
      result = await incremental();
    }
    return isApiEvent ? json(200, result) : result;
  } catch (err) {
    console.error('gmail-sync error:', (err as Error).message, (err as Error).stack);
    const errBody = { error: (err as Error).message };
    return isApiEvent ? json(500, errBody) : (errBody as unknown as SyncResult);
  }
};
