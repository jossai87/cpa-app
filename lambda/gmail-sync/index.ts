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
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SQSClient,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { searchEmails, getMessage, extractAttachments, ALL_GMAIL_ACCOUNTS, type GmailClientInstance } from '../gmail/client';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const EMBED_QUEUE_URL = process.env['EMBED_QUEUE_URL'] ?? '';
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

function extractEmailLocal(fromHeader: string): string | null {
  const m = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/([\w.+-]+@[\w.-]+)/);
  if (!m) return null;
  const email = (m[1] ?? '').trim().toLowerCase();
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(0, at) : null;
}

function extractDisplayName(fromHeader: string): string | null {
  const m = fromHeader.match(/^"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
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
}): 'invoice' | 'vendor' | 'customer' | 'corporate' | 'franchise' | 'internal' | null {
  const subj = args.subject.toLowerCase();
  const body = args.body.toLowerCase();
  const fromDomain = extractEmailDomain(args.fromHeader);
  const fromLocal = extractEmailLocal(args.fromHeader);
  const fromDisplay = extractDisplayName(args.fromHeader);
  const isFromOwner = fromDomain === OWNER_EMAIL_DOMAIN;
  const isFromVendor = isVendorDomain(fromDomain) || args.vendorBrand !== null;

  // Invoice signals — strongest, check first
  const invoiceRe =
    /\binvoice\b|\bamount due\b|\bpayment due\b|\bbalance due\b|\binvoice #|\bremittance\b|\bpayment reminder\b/;
  if (invoiceRe.test(subj) || invoiceRe.test(body)) return 'invoice';

  // Foot Solutions corporate / network classification
  // ────────────────────────────────────────────────
  // The store domain is footsolutions.com. Mail from this domain splits into:
  //   1. flowermound@        → 'internal' (your own store)
  //   2. <city>@             → 'franchise' (sister store)
  //   3. <person>@ or named  → 'corporate' (HQ leadership / ops / marketing)
  //
  // Outside footsolutions.com but with display names like
  // "Foot Solutions Franchise Group LLC" or "Foot Solutions Mail Service" =
  // HQ-affiliated systems (QuickBooks/Voxelcare). Classify those 'corporate'.
  if (isFromOwner) {
    if (fromLocal === 'flowermound') return 'internal';
    if (fromLocal && /^[a-z]+(staff)?$/.test(fromLocal)) return 'franchise';
    return 'corporate';
  }
  if (fromDisplay && /foot\s*solutions\s+(?:franchise|mail\s*service)/i.test(fromDisplay)) {
    return 'corporate';
  }
  if (
    fromDisplay &&
    /^foot\s*solutions(\s+\S+)?$/i.test(fromDisplay.trim()) &&
    fromDomain !== OWNER_EMAIL_DOMAIN
  ) {
    // "Foot Solutions <City> via Otter.ai" / "via Read AI" = sister-store recordings
    if (/via\s+(otter|read)/i.test(fromDisplay)) return 'franchise';
  }

  // Vendor: from a known vendor domain or mentions a brand
  if (isFromVendor) return 'vendor';

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
  kind: 'invoice' | 'vendor' | 'customer' | 'corporate' | 'franchise' | 'internal' | null;
  hasAttachment: boolean;
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  ttl: number;
  /** Which Gmail account this message came from. 'flowermound' = primary. */
  sourceAccount?: string;
}

async function writeMessage(msg: CachedMessage): Promise<void> {
  const items: Array<{ PutRequest: { Item: Record<string, unknown> } }> = [];
  const base: Record<string, unknown> = {
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
    attachments: msg.attachments,
    // Tag with source account so analysis can show which inbox each item came from.
    // Omit for primary account to keep backward compat with existing rows.
    ...(msg.sourceAccount && msg.sourceAccount !== 'flowermound'
      ? { sourceAccount: msg.sourceAccount }
      : {}),
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

  // Best-effort: enqueue an embed job. Failure here doesn't block the
  // canonical write — the SQS DLQ catches real failures, and the
  // backfillEmbeddings mode can replay any missed messages.
  if (EMBED_QUEUE_URL) {
    try {
      await enqueueEmbedJobs([{ messageId: msg.id, dateOnly: msg.dateOnly }]);
    } catch (err) {
      console.warn(`enqueue embed job failed for ${msg.id}: ${(err as Error).message}`);
    }
  }
}

// ── SQS enqueue helper ───────────────────────────────────────────────

interface EmbedJob {
  messageId: string;
  dateOnly: string;
}

async function enqueueEmbedJobs(jobs: EmbedJob[]): Promise<void> {
  if (!EMBED_QUEUE_URL || jobs.length === 0) return;
  // SQS SendMessageBatch caps at 10 entries per call.
  for (let i = 0; i < jobs.length; i += 10) {
    const slice = jobs.slice(i, i + 10);
    const entries: SendMessageBatchRequestEntry[] = slice.map((j, idx) => ({
      Id: String(i + idx),
      MessageBody: JSON.stringify(j),
    }));
    const res = await sqsClient.send(
      new SendMessageBatchCommand({ QueueUrl: EMBED_QUEUE_URL, Entries: entries })
    );
    if (res.Failed && res.Failed.length > 0) {
      console.warn(
        `enqueueEmbedJobs: ${res.Failed.length}/${slice.length} entries failed: ${JSON.stringify(res.Failed)}`
      );
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

async function listMessagesPageWithClient(
  client: GmailClientInstance,
  query: string,
  pageToken?: string
): Promise<GmailListPage> {
  // GmailClientInstance.searchEmails doesn't expose pagination, so we
  // use it for the first page only. For multi-page syncs the primary
  // account path still uses the raw fetch. This is fine for the Nancy
  // account which has ~35 messages total.
  const messages = await client.searchEmails(query, MAX_PER_PAGE);
  return { messages, resultSizeEstimate: messages.length };
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

async function runSync(
  query: string,
  mode: string,
  client?: GmailClientInstance,
  accountKey = 'flowermound'
): Promise<SyncResult> {
  const t0 = Date.now();
  let pageToken: string | undefined;
  let seen = 0;
  let written = 0;
  let skipped = 0;
  let truncated = false;

  // Use provided client or fall back to the legacy module-level functions
  const doSearch = client
    ? (q: string, tok?: string) => listMessagesPageWithClient(client, q, tok)
    : (q: string, tok?: string) => listMessagesPage(q, tok);
  const doGetMessage = client
    ? (id: string) => client.getMessage(id, BODY_CAP_BYTES)
    : (id: string) => getMessage(id, BODY_CAP_BYTES);

  while (true) {
    const page = await doSearch(query, pageToken);
    const ids = (page.messages ?? []).map((m: { id: string }) => m.id);
    seen += ids.length;

    for (const id of ids) {
      if (written + skipped >= HARD_PER_RUN_CAP) {
        truncated = true;
        break;
      }
      try {
        const detailed = await doGetMessage(id);
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
          hasAttachment: detailed.attachments.length > 0,
          attachments: detailed.attachments,
          ttl: ttlEpochSecs(detailed.date),
          sourceAccount: accountKey,
        };

        await writeMessage(cached);
        written++;
      } catch (err) {
        console.warn(`Failed to sync ${id} (${accountKey}): ${(err as Error).message}`);
      }
    }

    if (truncated) break;
    pageToken = (page as { nextPageToken?: string }).nextPageToken;
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

  // Run primary account first, then all secondary accounts.
  const primary = await runSync(query, 'backfill');
  let totalSeen = primary.messagesSeen;
  let totalWritten = primary.messagesWritten;
  let totalSkipped = primary.messagesSkipped;

  for (const { client, accountKey } of ALL_GMAIL_ACCOUNTS.slice(1)) {
    try {
      const r = await runSync(query, 'backfill', client, accountKey);
      totalSeen += r.messagesSeen;
      totalWritten += r.messagesWritten;
      totalSkipped += r.messagesSkipped;
    } catch (err) {
      console.error(`backfill failed for ${accountKey}:`, (err as Error).message);
    }
  }

  const result: SyncResult = {
    ...primary,
    messagesSeen: totalSeen,
    messagesWritten: totalWritten,
    messagesSkipped: totalSkipped,
  };
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
  const after = dateAgoStr(2);
  const query = `after:${gmailDate(after)} -category:promotions -category:social`;

  const primary = await runSync(query, 'incremental');
  let totalWritten = primary.messagesWritten;

  for (const { client, accountKey } of ALL_GMAIL_ACCOUNTS.slice(1)) {
    try {
      const r = await runSync(query, 'incremental', client, accountKey);
      totalWritten += r.messagesWritten;
    } catch (err) {
      console.error(`incremental failed for ${accountKey}:`, (err as Error).message);
    }
  }

  await saveState({
    lastIncrementalAdded: totalWritten,
    message: `Incremental sync added ${totalWritten} message(s) across all accounts.`,
  });
  return { ...primary, messagesWritten: totalWritten };
}

async function rangeSync(after: string, before: string): Promise<SyncResult> {
  const query = `after:${gmailDate(after)} before:${gmailDate(before)} -category:promotions -category:social`;
  const primary = await runSync(query, 'range');

  for (const { client, accountKey } of ALL_GMAIL_ACCOUNTS.slice(1)) {
    try {
      await runSync(query, 'range', client, accountKey);
    } catch (err) {
      console.error(`rangeSync failed for ${accountKey}:`, (err as Error).message);
    }
  }
  return primary;
}

// ── Reclassify ───────────────────────────────────────────────────────
//
// Walk every canonical message in the cache and re-run the classifier on
// its existing fields. Useful when the classifier logic changes (e.g.
// adding new `kind` categories) — avoids re-fetching from Gmail.
async function reclassify(): Promise<SyncResult> {
  const t0 = Date.now();
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  while (true) {
    const res = await docClient.send(
      new (await import('@aws-sdk/lib-dynamodb')).QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':u': OWNER_USER_ID, ':p': 'GMAIL#MSG#' },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of (res.Items ?? []) as Record<string, unknown>[]) {
      scanned++;
      const fromHeader = String(item['from'] ?? '');
      const subject = String(item['subject'] ?? '');
      const snippet = String(item['snippet'] ?? '');
      const body = String(item['bodyText'] ?? '');
      const headerForBrand = `${fromHeader} ${subject} ${snippet}`;
      const newVendor = detectVendorBrand(headerForBrand);
      const newKind = classifyKind({
        fromHeader,
        toHeader: String(item['to'] ?? ''),
        subject,
        body,
        vendorBrand: newVendor,
      });
      const oldKind = (item['kind'] as string | null) ?? null;
      const oldVendor = (item['vendorBrand'] as string | null) ?? null;
      if (oldKind === newKind && oldVendor === newVendor) {
        unchanged++;
        continue;
      }

      // Rebuild the canonical row + pointer rows with the new kind/vendor.
      // We read the full body back into the cache write helper.
      const cached: CachedMessage = {
        id: String(item['id']),
        threadId: String(item['threadId']),
        date: String(item['date']),
        dateOnly: String(item['dateOnly']),
        from: fromHeader,
        to: String(item['to'] ?? ''),
        subject,
        snippet,
        bodyText: body,
        bodyTruncated: !!item['bodyTruncated'],
        vendorBrand: newVendor,
        kind: newKind,
        hasAttachment: !!item['hasAttachment'],
        attachments: (item['attachments'] as Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> | undefined) ?? [],
        ttl: Number(item['ttl']) || ttlEpochSecs(String(item['date'])),
      };

      // Best-effort: delete old pointer rows that no longer apply, then write
      // fresh ones via writeMessage(). DDB BatchWrite supports DeleteRequest.
      const { BatchWriteCommand: BWC } = await import('@aws-sdk/lib-dynamodb');
      const deletes: Array<{ DeleteRequest: { Key: Record<string, string> } }> = [];
      if (oldVendor && oldVendor !== newVendor) {
        deletes.push({
          DeleteRequest: {
            Key: {
              userId: OWNER_USER_ID,
              sk: `GMAIL#VENDOR#${sanitizeBrand(oldVendor)}#${cached.dateOnly}#${cached.id}`,
            },
          },
        });
      }
      if (oldKind && oldKind !== newKind) {
        deletes.push({
          DeleteRequest: {
            Key: {
              userId: OWNER_USER_ID,
              sk: `GMAIL#KIND#${oldKind}#${cached.dateOnly}#${cached.id}`,
            },
          },
        });
      }
      if (deletes.length > 0) {
        await docClient.send(new BWC({ RequestItems: { [TABLE_NAME]: deletes } }));
      }

      await writeMessage(cached);
      updated++;
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }

  await saveState({
    message: `Reclassified ${updated} of ${scanned} messages (${unchanged} unchanged).`,
  });

  return {
    mode: 'reclassify',
    query: '(local reclassify)',
    messagesSeen: scanned,
    messagesWritten: updated,
    messagesSkipped: unchanged,
    durationMs: Date.now() - t0,
    truncated: false,
  };
}

// ── Embedding backfill mode ──────────────────────────────────────────
//
// Scans every canonical Gmail message row and enqueues an embed job for
// each. Idempotent: the embed Lambda overwrites by key. Use after first
// deploy of the S3 Vectors stack to seed the index from existing cache.

async function backfillEmbeddings(): Promise<SyncResult> {
  const t0 = Date.now();
  if (!EMBED_QUEUE_URL) {
    return {
      mode: 'backfillEmbeddings',
      query: '(none)',
      messagesSeen: 0,
      messagesWritten: 0,
      messagesSkipped: 0,
      durationMs: Date.now() - t0,
      truncated: false,
    };
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let enqueued = 0;
  const buffer: EmbedJob[] = [];

  while (true) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':u': OWNER_USER_ID, ':p': 'GMAIL#MSG#' },
        ProjectionExpression: '#id, dateOnly',
        ExpressionAttributeNames: { '#id': 'id' },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of res.Items ?? []) {
      const messageId = String(item['id'] ?? '');
      const dateOnly = String(item['dateOnly'] ?? '');
      if (!messageId || !dateOnly) continue;
      buffer.push({ messageId, dateOnly });
      scanned++;
      if (buffer.length >= 10) {
        await enqueueEmbedJobs(buffer.splice(0, buffer.length));
        enqueued = scanned;
      }
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }
  if (buffer.length > 0) {
    await enqueueEmbedJobs(buffer);
    enqueued = scanned;
  }

  return {
    mode: 'backfillEmbeddings',
    query: '(scan canonical rows)',
    messagesSeen: scanned,
    messagesWritten: enqueued,
    messagesSkipped: 0,
    durationMs: Date.now() - t0,
    truncated: false,
  };
}

// ── Lambda entry — supports both EventBridge and API Gateway events ──

interface EventBridgeInvoke {
  mode?: 'backfill' | 'incremental' | 'range' | 'reclassify' | 'backfillEmbeddings';
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

  let mode: 'backfill' | 'incremental' | 'range' | 'reclassify' | 'backfillEmbeddings' = 'incremental';
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
    } else if (mode === 'reclassify') {
      result = await reclassify();
    } else if (mode === 'backfillEmbeddings') {
      result = await backfillEmbeddings();
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
