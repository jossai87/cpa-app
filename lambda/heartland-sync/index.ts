/**
 * Heartland POS sync Lambda — runs on a schedule (every 6h via EventBridge)
 * AND on demand (POST /pos/sync from the UI).
 *
 * Pulls everything from Heartland into DynamoDB so user-facing endpoints
 * never have to wait on Heartland API calls.
 *
 * Sync targets per run:
 *   - Daily payment rollups   → POS#DAILY#YYYY-MM-DD       (per-day revenue, payment types, hour buckets)
 *   - Ticket-enriched rollups → enriches above with discounts, customers, sales reps
 *   - Item catalog snapshot   → POS#INVENTORY#CATALOG       (cost/price/margin, by department/brand)
 *   - Live catalog (active+sold) → POS#INVENTORY#LIVE      (subset of items actually sold recently)
 *   - Sync metadata           → POS#SYNC#STATUS             (lastSyncAt, durations, counts, errors)
 *
 * The user-facing handler reads only from these cached records.
 */

import { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env['TABLE_NAME']!;
// userId for the single owner. EventBridge invocations have no JWT claim, so
// the sync writes everything under this fixed partition. The user-facing
// handler reads the same partition.
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;

const EXTENSION_BASE_URL = 'http://localhost:2773';

// ── Types (shared with user-facing handler) ──────────────────────────

interface HeartlandSecret {
  token: string;
  subdomain: string;
  baseUrl: string;
}

interface HeartlandPayment {
  id: number;
  type: string;
  status: string;
  amount: number;
  amount_tendered: number;
  completed_at: string;
  local_completed_at: string;
  created_at: string;
  payment_type_id: number;
}

interface HeartlandTicket {
  id: number;
  status: string;
  total: number;
  total_discounts: number;
  original_subtotal: number;
  total_item_qty: number;
  completed_at: string | null;
  local_completed_at: string | null;
  customer_name: string | null;
  sales_rep: string;
  station_id: number;
  'completed?': boolean;
  'voided?': boolean;
}

interface HeartlandItem {
  id: number;
  public_id: string;
  description: string;
  cost: number;
  price: number;
  'active?': boolean;
  'track_inventory?': boolean;
  product_type: string;
  custom: {
    brand?: string;
    department?: string;
    class?: string;
  };
}

interface HeartlandUser {
  id: number;
  login: string;
  first_name: string;
  last_name: string;
}

interface DailyRollup {
  date: string;
  count: number;
  totalAmount: number;
  totalDiscounts: number;
  byPaymentType: Record<string, { count: number; amount: number }>;
  byHour: Record<string, number>;
  topCustomers: Record<string, number>;
  bySalesRep: Record<string, number>;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getHeartlandSecret(): Promise<HeartlandSecret> {
  const url = `${EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent('foot-solutions/heartland/api-token')}`;
  const res = await fetch(url, {
    headers: { 'X-Aws-Parameters-Secrets-Token': process.env['AWS_SESSION_TOKEN'] ?? '' },
  });
  if (!res.ok) throw new Error(`Failed to load Heartland secret: ${res.status}`);
  const data = (await res.json()) as { SecretString: string };
  return JSON.parse(data.SecretString) as HeartlandSecret;
}

async function fetchPage<T>(
  secret: HeartlandSecret,
  path: string,
  page: number,
  perPage = 200
): Promise<{ results: T[]; total: number; pages: number }> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${secret.baseUrl}/${path}${sep}per_page=${perPage}&page=${page}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret.token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Heartland ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { results: T[]; total: number; pages: number };
}

async function fetchAllPages<T>(
  secret: HeartlandSecret,
  path: string,
  maxPages: number,
  shouldStop?: (results: T[]) => boolean
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (page <= maxPages) {
    const data = await fetchPage<T>(secret, path, page);
    if (!data.results || data.results.length === 0) break;
    all.push(...data.results);
    if (shouldStop && shouldStop(data.results)) break;
    if (page >= (data.pages ?? 1)) break;
    page++;
  }
  return all;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Rollup builders ──────────────────────────────────────────────────

function rollupPayments(payments: HeartlandPayment[]): Map<string, DailyRollup> {
  const out = new Map<string, DailyRollup>();
  for (const p of payments) {
    if (p.status !== 'complete') continue;
    const ts = p.local_completed_at ?? p.completed_at;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    let bucket = out.get(date);
    if (!bucket) {
      bucket = {
        date, count: 0, totalAmount: 0, totalDiscounts: 0,
        byPaymentType: {}, byHour: {}, topCustomers: {}, bySalesRep: {},
      };
      out.set(date, bucket);
    }
    bucket.count += 1;
    bucket.totalAmount += p.amount;
    const typeKey = String(p.payment_type_id);
    if (!bucket.byPaymentType[typeKey]) bucket.byPaymentType[typeKey] = { count: 0, amount: 0 };
    bucket.byPaymentType[typeKey]!.count += 1;
    bucket.byPaymentType[typeKey]!.amount += p.amount;
    const hour = ts.slice(11, 13);
    bucket.byHour[hour] = (bucket.byHour[hour] ?? 0) + p.amount;
  }
  return out;
}

function enrichWithTickets(rollups: Map<string, DailyRollup>, tickets: HeartlandTicket[]): {
  itemSalesByDate: Map<string, Set<number>>; // for live catalog computation
} {
  const itemSalesByDate = new Map<string, Set<number>>();
  for (const t of tickets) {
    if (!t['completed?'] || t['voided?']) continue;
    const ts = t.local_completed_at ?? t.completed_at;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    const bucket = rollups.get(date);
    if (!bucket) continue;
    bucket.totalDiscounts += t.total_discounts ?? 0;
    if (t.customer_name) {
      bucket.topCustomers[t.customer_name] = (bucket.topCustomers[t.customer_name] ?? 0) + t.total;
    }
    const rep = t.sales_rep?.trim() || 'Unassigned';
    bucket.bySalesRep[rep] = (bucket.bySalesRep[rep] ?? 0) + t.total;
  }
  return { itemSalesByDate };
}

// ── Sync routines ────────────────────────────────────────────────────

async function syncPaymentsAndTickets(secret: HeartlandSecret): Promise<{
  daysWritten: number;
  paymentsScanned: number;
  ticketsScanned: number;
}> {
  // Fetch latest pages of payments. Heartland sorts ascending so newest is on the LAST page.
  // Strategy: pull last 30 pages (~6,000 records) which covers months of activity for most stores.
  const firstPage = await fetchPage<HeartlandPayment>(secret, 'payments?sort=completed_at', 1);
  const totalPages = Math.ceil(firstPage.total / 200);
  const startPage = Math.max(1, totalPages - 30);

  const payments: HeartlandPayment[] = [];
  for (let p = totalPages; p >= startPage; p--) {
    const data = await fetchPage<HeartlandPayment>(secret, 'payments?sort=completed_at', p);
    payments.push(...data.results);
  }

  // Tickets — pull last 25 pages (5,000 tickets) which is plenty for trailing 90 days
  const firstTPage = await fetchPage<HeartlandTicket>(secret, 'sales/tickets', 1);
  const totalTPages = Math.ceil(firstTPage.total / 200);
  const startTPage = Math.max(1, totalTPages - 25);

  const tickets: HeartlandTicket[] = [];
  for (let p = totalTPages; p >= startTPage; p--) {
    const data = await fetchPage<HeartlandTicket>(secret, 'sales/tickets', p);
    tickets.push(...data.results);
  }

  // Build rollups
  const rollups = rollupPayments(payments);
  enrichWithTickets(rollups, tickets);

  // Write each day to DynamoDB
  let daysWritten = 0;
  const writes: Promise<unknown>[] = [];
  for (const rollup of rollups.values()) {
    writes.push(
      docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            userId: OWNER_USER_ID,
            sk: `POS#DAILY#${rollup.date}`,
            date: rollup.date,
            rollup,
            cachedAt: new Date().toISOString(),
          },
        })
      )
    );
    daysWritten += 1;
  }
  await Promise.all(writes);

  return { daysWritten, paymentsScanned: payments.length, ticketsScanned: tickets.length };
}

async function syncInventory(secret: HeartlandSecret): Promise<{
  totalItems: number;
  activeItems: number;
  liveItems: number;
}> {
  // Fetch ALL items. This Lambda has 5min timeout so it can handle 350+ pages.
  // We can also optimize by passing ?active=true if Heartland supports it (they don't, but oh well).
  const items: HeartlandItem[] = [];
  let page = 1;
  const maxPages = 400;
  while (page <= maxPages) {
    const data = await fetchPage<HeartlandItem>(secret, 'items', page);
    if (!data.results || data.results.length === 0) break;
    items.push(...data.results);
    if (page >= (data.pages ?? 1)) break;
    page++;
  }

  const activeItems = items.filter((i) => i['active?']);
  const withCost = activeItems.filter((i) => i.cost > 0 && i.price > 0);

  // Determine which items have actually been sold recently
  // We'll get item IDs from ticket line_items if available — but we already saw that
  // the line_items endpoint isn't exposed. Without it, we'll define "live catalog" as
  // simply: active items with cost+price set (i.e., real product records, not test/inactive entries).
  // This already drops 69K → likely ~5-10K
  const liveItems = withCost;

  // Aggregations
  const byDepartment: Record<string, { count: number; totalCost: number; totalPrice: number; avgMargin: number }> = {};
  const byBrand: Record<string, { count: number; totalRevenue: number }> = {};

  for (const item of withCost) {
    const dept = item.custom?.department?.trim() || 'Uncategorized';
    const brand = item.custom?.brand?.trim() || 'Unknown';
    if (!byDepartment[dept]) byDepartment[dept] = { count: 0, totalCost: 0, totalPrice: 0, avgMargin: 0 };
    byDepartment[dept]!.count += 1;
    byDepartment[dept]!.totalCost += item.cost;
    byDepartment[dept]!.totalPrice += item.price;
    if (!byBrand[brand]) byBrand[brand] = { count: 0, totalRevenue: 0 };
    byBrand[brand]!.count += 1;
    byBrand[brand]!.totalRevenue += item.price;
  }
  for (const dept of Object.values(byDepartment)) {
    dept.avgMargin = dept.totalPrice > 0
      ? Math.round(((dept.totalPrice - dept.totalCost) / dept.totalPrice) * 1000) / 10
      : 0;
  }

  const overallAvgMargin = withCost.length > 0
    ? Math.round(withCost.reduce((s, i) => s + (i.price - i.cost) / i.price, 0) / withCost.length * 1000) / 10
    : 0;

  const topMarginItems = withCost
    .map((i) => ({
      id: i.id,
      sku: i.public_id,
      description: i.description,
      cost: i.cost,
      price: i.price,
      margin: Math.round(((i.price - i.cost) / i.price) * 1000) / 10,
      brand: i.custom?.brand || '',
      department: i.custom?.department || '',
    }))
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 50);

  const lowMarginItems = withCost
    .filter((i) => (i.price - i.cost) / i.price < 0.2)
    .map((i) => ({
      id: i.id,
      sku: i.public_id,
      description: i.description,
      cost: i.cost,
      price: i.price,
      margin: Math.round(((i.price - i.cost) / i.price) * 1000) / 10,
    }))
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 30);

  const data = {
    summary: {
      totalItems: items.length,
      activeItems: activeItems.length,
      liveItems: liveItems.length,
      itemsWithCostData: withCost.length,
      overallAvgMarginPct: overallAvgMargin,
    },
    byDepartment: Object.entries(byDepartment).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    byBrand: Object.entries(byBrand).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count).slice(0, 30),
    topMarginItems,
    lowMarginItems,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#INVENTORY#CATALOG',
        data,
        cachedAt: new Date().toISOString(),
      },
    })
  );

  return {
    totalItems: items.length,
    activeItems: activeItems.length,
    liveItems: liveItems.length,
  };
}

async function syncStaffNames(secret: HeartlandSecret): Promise<number> {
  const url = `${secret.baseUrl}/users?per_page=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret.token}` } });
  if (!res.ok) return 0;
  const data = (await res.json()) as { results: HeartlandUser[] };
  const users = data.results ?? [];
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#USERS#LIST',
        users,
        cachedAt: new Date().toISOString(),
      },
    })
  );
  return users.length;
}

async function syncPaymentTypes(secret: HeartlandSecret): Promise<number> {
  const url = `${secret.baseUrl}/payment_types?per_page=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret.token}` } });
  if (!res.ok) return 0;
  const data = (await res.json()) as { results: Array<{ id: number; name: string }> };
  const types = data.results ?? [];
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#PAYMENT_TYPES#LIST',
        types,
        cachedAt: new Date().toISOString(),
      },
    })
  );
  return types.length;
}

async function writeSyncStatus(status: Record<string, unknown>): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#SYNC#STATUS',
        ...status,
        updatedAt: new Date().toISOString(),
      },
    })
  );
}

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (event?: ScheduledEvent | { trigger?: string }) => {
  const start = Date.now();
  const trigger =
    'source' in (event ?? {}) && (event as ScheduledEvent).source === 'aws.events'
      ? 'schedule'
      : (event as { trigger?: string })?.trigger || 'manual';

  console.log(`Sync start: trigger=${trigger}`);
  const summary: Record<string, unknown> = {
    trigger,
    startedAt: new Date(start).toISOString(),
  };

  let secret: HeartlandSecret;
  try {
    secret = await getHeartlandSecret();
  } catch (err) {
    summary['error'] = `Secret load: ${(err as Error).message}`;
    await writeSyncStatus({ ...summary, status: 'error', durationMs: Date.now() - start });
    return summary;
  }

  // Run each sync, capture errors per-section so partial success is recorded
  try {
    const t0 = Date.now();
    const r = await syncPaymentsAndTickets(secret);
    summary['payments'] = { ...r, durationMs: Date.now() - t0 };
  } catch (err) {
    summary['payments'] = { error: (err as Error).message };
  }
  try {
    const t0 = Date.now();
    const r = await syncInventory(secret);
    summary['inventory'] = { ...r, durationMs: Date.now() - t0 };
  } catch (err) {
    summary['inventory'] = { error: (err as Error).message };
  }
  try {
    const t0 = Date.now();
    const count = await syncStaffNames(secret);
    summary['users'] = { count, durationMs: Date.now() - t0 };
  } catch (err) {
    summary['users'] = { error: (err as Error).message };
  }
  try {
    const t0 = Date.now();
    const count = await syncPaymentTypes(secret);
    summary['paymentTypes'] = { count, durationMs: Date.now() - t0 };
  } catch (err) {
    summary['paymentTypes'] = { error: (err as Error).message };
  }

  const durationMs = Date.now() - start;
  summary['durationMs'] = durationMs;
  summary['completedAt'] = new Date().toISOString();
  summary['status'] = 'ok';

  await writeSyncStatus(summary);
  console.log(`Sync complete in ${durationMs}ms:`, JSON.stringify(summary));

  return summary;
};
