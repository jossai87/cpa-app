/**
 * Cache query helpers — read the local Gmail cache that gmail-sync writes.
 *
 * Schema is single-table with these SK shapes:
 *   GMAIL#MSG#<YYYY-MM-DD>#<id>                  ← canonical, full body
 *   GMAIL#THREAD#<threadId>#<YYYY-MM-DD>#<id>    ← thread index
 *   GMAIL#VENDOR#<brand-slug>#<YYYY-MM-DD>#<id>  ← vendor index
 *   GMAIL#KIND#<kind>#<YYYY-MM-DD>#<id>          ← kind index (invoice|vendor|customer|internal)
 *
 * These helpers are imported by both the gmail-analysis Lambda and the
 * sales-chat Lambda so both chatbots share the same fast read path.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;

export interface CachedQueryArgs {
  /** Limit to a vendor brand (matches what sync stored — case-insensitive). */
  vendor?: string;
  /** Limit to a thread id. */
  threadId?: string;
  /** Limit to a classification: invoice | vendor | customer | internal */
  kind?: string;
  /** YYYY-MM-DD inclusive. */
  since?: string;
  /** YYYY-MM-DD inclusive. */
  until?: string;
  /** Free-text filter applied client-side after Query. */
  text?: string;
  /** From-header substring filter (case-insensitive). */
  from?: string;
  /** Max results (default 25, hard cap 100). */
  limit?: number;
}

interface CachedRow {
  id: string;
  threadId: string;
  date: string;
  dateOnly: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyText?: string;
  bodyTruncated?: boolean;
  vendorBrand: string | null;
  kind: string | null;
  hasAttachment: boolean;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  /** Which Gmail account this message came from. Absent = primary (flowermound). */
  sourceAccount?: string;
}

function brandSlug(b: string): string {
  return b.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function inDateWindow(dateOnly: string, since?: string, until?: string): boolean {
  if (since && dateOnly < since) return false;
  if (until && dateOnly > until) return false;
  return true;
}

/**
 * Pick the best index to query against based on the args. Falls back to
 * scanning the canonical date range when no specific index is requested.
 *
 * Returns metadata-only rows (no body) so the model can pick a few then
 * call cacheRead() for full content.
 */
export async function cacheQuery(args: CachedQueryArgs): Promise<{
  total: number;
  rows: Omit<CachedRow, 'bodyText' | 'bodyTruncated'>[];
}> {
  const limit = Math.min(args.limit ?? 25, 100);
  const since = args.since ?? '2000-01-01';
  const until = args.until ?? '2999-12-31';

  // Pick the most selective SK prefix
  let skPrefix: string;
  if (args.vendor) {
    skPrefix = `GMAIL#VENDOR#${brandSlug(args.vendor)}#`;
  } else if (args.threadId) {
    skPrefix = `GMAIL#THREAD#${args.threadId}#`;
  } else if (args.kind) {
    skPrefix = `GMAIL#KIND#${args.kind.toLowerCase()}#`;
  } else {
    skPrefix = 'GMAIL#MSG#';
  }

  // Querying with a date window: use BETWEEN to take advantage of the
  // sort key when the prefix is date-anchored. For VENDOR/THREAD/KIND the
  // <YYYY-MM-DD> comes after the brand/thread/kind, so we still get an
  // efficient scan.
  const skLow = `${skPrefix}${since}`;
  // Use the highest possible suffix so BETWEEN catches everything up through `until`
  const skHigh = `${skPrefix}${until}\uffff`;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  const collected: CachedRow[] = [];

  while (collected.length < limit * 4) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND sk BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':lo': skLow, ':hi': skHigh },
        ExclusiveStartKey: exclusiveStartKey,
        Limit: 200,
      })
    );

    for (const item of res.Items ?? []) {
      const row = item as unknown as CachedRow;
      // Free-text + from filters happen here (DDB doesn't help).
      if (args.text) {
        const t = args.text.toLowerCase();
        const hay = `${row.subject ?? ''} ${row.snippet ?? ''}`.toLowerCase();
        if (!hay.includes(t)) continue;
      }
      if (args.from) {
        if (!(row.from ?? '').toLowerCase().includes(args.from.toLowerCase())) continue;
      }
      if (!inDateWindow(row.dateOnly, args.since, args.until)) continue;
      collected.push(row);
      if (collected.length >= limit * 4) break;
    }

    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }

  // Dedupe by id (vendor/kind/thread pointers cover the same canonical msg)
  const byId = new Map<string, CachedRow>();
  for (const r of collected) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const deduped = [...byId.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const top = deduped.slice(0, limit);

  return {
    total: deduped.length,
    rows: top.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      date: r.date,
      dateOnly: r.dateOnly,
      from: r.from,
      to: r.to,
      subject: r.subject,
      snippet: r.snippet,
      vendorBrand: r.vendorBrand,
      kind: r.kind,
      hasAttachment: r.hasAttachment,
      attachments: r.attachments ?? [],
      sourceAccount: r.sourceAccount,
    })),
  };
}

/** Read a single message including bodyText. Provide dateOnly for fastest path. */
export async function cacheRead(id: string, dateOnly?: string): Promise<CachedRow | null> {
  if (dateOnly) {
    return cacheReadByKey(id, dateOnly);
  }
  // Without dateOnly we can't form the canonical key, so we scan the
  // canonical prefix with a FilterExpression on `id`. The PK is fixed to
  // OWNER_USER_ID so only this user's rows are scanned.
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'userId = :uid AND begins_with(sk, :p)',
      FilterExpression: '#id = :id',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: {
        ':uid': OWNER_USER_ID,
        ':p': 'GMAIL#MSG#',
        ':id': id,
      },
    })
  );
  const found = (res.Items ?? []).find((it) => it['id'] === id);
  return found ? (found as unknown as CachedRow) : null;
}

/** Faster read when the caller already knows the dateOnly. */
export async function cacheReadByKey(id: string, dateOnly: string): Promise<CachedRow | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: `GMAIL#MSG#${dateOnly}#${id}` },
    })
  );
  return (res.Item as unknown as CachedRow) ?? null;
}

/**
 * Vendor activity rollup — used by the Sales & Revenue Vendor Health view
 * and by chatbot tools answering "what has Brooks been up to lately?"
 *
 * Returns last contact, message count in window, top topics, top senders.
 */
export interface VendorActivity {
  vendor: string;
  messageCount: number;
  lastContactDate: string | null;
  topSenders: Array<{ from: string; count: number }>;
  topSubjects: Array<{ subject: string; count: number }>;
  recentMessageIds: string[];
}

export async function cacheVendorActivity(
  vendor: string,
  days = 90
): Promise<VendorActivity> {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const result = await cacheQuery({ vendor, since, limit: 100 });

  const senders = new Map<string, number>();
  const subjects = new Map<string, number>();
  let last: string | null = null;
  for (const r of result.rows) {
    if (r.from) senders.set(r.from, (senders.get(r.from) ?? 0) + 1);
    if (r.subject) subjects.set(r.subject, (subjects.get(r.subject) ?? 0) + 1);
    if (!last || (r.date ?? '') > last) last = r.date ?? null;
  }

  return {
    vendor,
    messageCount: result.rows.length,
    lastContactDate: last,
    topSenders: [...senders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([from, count]) => ({ from, count })),
    topSubjects: [...subjects.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([subject, count]) => ({ subject, count })),
    recentMessageIds: result.rows.slice(0, 10).map((r) => r.id),
  };
}

/**
 * Resolve message IDs to thread IDs from the cache.
 *
 * Gmail's deep-link URL (`#inbox/<id>` / `#all/<id>`) expects a threadId,
 * not the API messageId. The two are different. This helper looks up each
 * id in the cache and returns the matching threadId where available.
 *
 * Falls back to the messageId itself for any id we don't have cached, so
 * the URL still attempts a best-effort match instead of dropping.
 */
export async function resolveThreadIds(
  messageIds: string[]
): Promise<Record<string, string>> {
  if (!messageIds || messageIds.length === 0) return {};
  const out: Record<string, string> = {};

  // Query the canonical prefix and filter client-side. We MUST paginate
  // through every page until we either find the message OR exhaust the
  // cache. DynamoDB applies FilterExpression per page (after the 1MB
  // read limit), so a single Query that returns no Items doesn't mean
  // "not in the cache" — it just means "not on the first page".
  await Promise.all(
    messageIds.map(async (id) => {
      try {
        let exclusiveStartKey: Record<string, unknown> | undefined;
        let resolved: string | null = null;
        // Hard upper bound on pages so a runaway loop can't burn DDB
        // capacity. The cache is bounded at O(thousands), and each page
        // is up to 1MB worth of rows — 50 pages is far past worst case.
        for (let page = 0; page < 50; page++) {
          const res = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
              FilterExpression: '#i = :i',
              ExpressionAttributeNames: { '#i': 'id' },
              ExpressionAttributeValues: {
                ':u': OWNER_USER_ID,
                ':p': 'GMAIL#MSG#',
                ':i': id,
              },
              ProjectionExpression: 'threadId, #i',
              ExclusiveStartKey: exclusiveStartKey,
            })
          );
          const found = (res.Items ?? []).find((it) => it['id'] === id);
          if (found && found['threadId']) {
            resolved = String(found['threadId']);
            break;
          }
          if (!res.LastEvaluatedKey) break;
          exclusiveStartKey = res.LastEvaluatedKey;
        }
        out[id] = resolved ?? id; // fallback: messageId itself
      } catch {
        out[id] = id;
      }
    })
  );
  return out;
}

/** Coverage stats so the UI can show "X messages cached, oldest from Y". */
export async function cacheStats(): Promise<{
  totalCanonical: number;
  oldestDate: string | null;
  newestDate: string | null;
  byKind: Record<string, number>;
}> {
  // One query over the canonical prefix, paginated.
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let total = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  const byKind: Record<string, number> = {};

  while (true) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':p': 'GMAIL#MSG#' },
        ProjectionExpression: 'dateOnly, kind',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const it of res.Items ?? []) {
      total++;
      const d = it['dateOnly'] as string | undefined;
      if (d) {
        if (!oldest || d < oldest) oldest = d;
        if (!newest || d > newest) newest = d;
      }
      const k = (it['kind'] as string | null) ?? 'unclassified';
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }

  return { totalCanonical: total, oldestDate: oldest, newestDate: newest, byKind };
}
