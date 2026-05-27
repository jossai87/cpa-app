/**
 * Heartland POS sync Lambda — runs on a schedule (every 6h via EventBridge)
 * AND on demand (POST /pos/sync from the UI).
 *
 * Uses the CORRECT Heartland API paths from dev.retail.heartland.us docs.
 *
 * Sync targets:
 *   POS#DAILY#YYYY-MM-DD       — daily payment rollups (revenue, payment types, hours)
 *   POS#INVENTORY#CATALOG      — per-location stock from /inventory/values (location 100006)
 *   POS#PURCHASING#VENDORS     — vendor list from /purchasing/vendors
 *   POS#PURCHASING#ORDERS      — recent purchase orders from /purchasing/orders
 *   POS#REPORTING#SALES        — reporting/analyzer net sales by date
 *   POS#USERS#LIST             — staff list
 *   POS#PAYMENT_TYPES#LIST     — payment type labels
 *   POS#SYNC#STATUS            — last sync metadata
 *
 * Flower Mound location ID: 100006
 */

import { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
// Flower Mound location ID confirmed from /api/locations
const FLOWER_MOUND_LOCATION_ID = 100006;

const EXTENSION_BASE_URL = 'http://localhost:2773';

// ── Types ────────────────────────────────────────────────────────────

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
  completed_at: string;
  local_completed_at: string;
  payment_type_id: number;
}

interface HeartlandTicket {
  id: number;
  total: number;
  total_tax: number;
  total_discounts: number;
  completed_at: string | null;
  local_completed_at: string | null;
  customer_name: string | null;
  customer_id?: number | null;
  sales_rep: string;
  'completed?': boolean;
  'voided?': boolean;
}

interface HeartlandTicketLine {
  id: number;
  type: string;
  item_id: number | null;
  qty: number;
  value: number;
  adjusted_unit_price: number;
  unit_cost: number;
  original_unit_price: number;
}

interface HeartlandInventoryValue {
  item_id?: number;
  location_id?: number;
  qty: number;
  qty_on_hand: number;
  qty_committed: number;
  qty_on_po: number;
  qty_in_transit: number;
  qty_available: number;
  unit_cost: number;
}

interface HeartlandVendor {
  id: number;
  name?: string;
  public_id?: string;
  active?: boolean;
}

interface HeartlandOrder {
  id: number;
  public_id?: string;
  status?: string;
  vendor_id?: number;
  receive_at_location_id?: number;
  total_qty?: number;
  total_cost?: number;
  total_received_qty?: number;
  total_open_qty?: number;
  created_at?: string;
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
  /** Tax collected per sales rep (deduct from bySalesRep for ex-tax revenue). */
  taxBySalesRep: Record<string, number>;
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

// ── Sync: Payments + Tickets (daily rollups) ─────────────────────────

async function syncPaymentsAndTickets(secret: HeartlandSecret): Promise<{
  daysWritten: number;
  paymentsScanned: number;
  ticketsScanned: number;
}> {
  // Use Central Time for date boundaries — Heartland stores local_completed_at
  // in store-local (Central) time, so we must query the same way.
  const STORE_TZ = 'America/Chicago';
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = fmtDate.format(new Date());
  // Sync a rolling 35-day window so we always have at least a full month of
  // daily rollups, plus a buffer for late-arriving transactions.
  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - 35);
  const fromDate = fmtDate.format(windowStart);

  // Payments — filter by `local_completed_at` (store-local Central
  // time) using Heartland's documented JSON filter syntax (per
  // https://dev.retail.heartland.us/ §Filtering / "Using JSON").
  // Why local_completed_at vs completed_at:
  //   completed_at is UTC, but the rollup keys bucket by store-local
  //   date (we slice local_completed_at[:10]). For dates near midnight
  //   UTC, a UTC filter misses payments that happened today in Central.
  //   Direct probe of Heartland confirms local_completed_at returns the
  //   correct count for today while completed_at returns 0.
  // Why no location_id filter:
  //   Heartland's /payments endpoint doesn't accept location_id as a
  //   filter (returns 400 invalid_request). Payments belong to a sales
  //   transaction; location is on the ticket. We filter client-side
  //   below using each payment's joined ticket.
  const paymentFilter = JSON.stringify({
    local_completed_at: {
      $gte: `${fromDate}T00:00:00`,
      $lte: `${today}T23:59:59`,
    },
    status: 'complete',
  });
  const paymentPath =
    `payments?sort=local_completed_at&_filter=${encodeURIComponent(paymentFilter)}`;
  const firstPage = await fetchPage<HeartlandPayment>(secret, paymentPath, 1);
  const totalPages = Math.ceil(firstPage.total / 200);

  const payments: HeartlandPayment[] = [...firstPage.results];
  for (let p = 2; p <= totalPages; p++) {
    const data = await fetchPage<HeartlandPayment>(secret, paymentPath, p);
    payments.push(...data.results);
  }

  // Tickets — filter by local_completed_at only. The `completed?` and
  // `voided?` boolean fields aren't filterable on this endpoint
  // (Heartland returns 400). The rollup loop below already filters
  // client-side via `t['completed?'] && !t['voided?']`. Same for
  // location — `source_location_id` filter returns 400, so we filter
  // client-side after fetching.
  const ticketFilter = JSON.stringify({
    local_completed_at: {
      $gte: `${fromDate}T00:00:00`,
      $lte: `${today}T23:59:59`,
    },
  });
  const ticketPath =
    `sales/tickets?_filter=${encodeURIComponent(ticketFilter)}`;
  const firstTPage = await fetchPage<HeartlandTicket>(secret, ticketPath, 1);
  const totalTPages = Math.ceil(firstTPage.total / 200);

  const tickets: HeartlandTicket[] = [...firstTPage.results];
  for (let p = 2; p <= totalTPages; p++) {
    const data = await fetchPage<HeartlandTicket>(secret, ticketPath, p);
    tickets.push(...data.results);
  }

  // Build rollups from payments
  const rollups = new Map<string, DailyRollup>();
  for (const p of payments) {
    if (p.status !== 'complete') continue;
    const ts = p.local_completed_at ?? p.completed_at;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    let bucket = rollups.get(date);
    if (!bucket) {
      bucket = {
        date, count: 0, totalAmount: 0, totalDiscounts: 0,
        byPaymentType: {}, byHour: {}, topCustomers: {}, bySalesRep: {}, taxBySalesRep: {},
      };
      rollups.set(date, bucket);
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

  // Enrich with ticket data
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
    bucket.taxBySalesRep[rep] = (bucket.taxBySalesRep[rep] ?? 0) + (t.total_tax ?? 0);
  }

  // Write to DynamoDB
  const writes: Promise<unknown>[] = [];
  for (const rollup of rollups.values()) {
    writes.push(
      docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: OWNER_USER_ID,
          sk: `POS#DAILY#${rollup.date}`,
          date: rollup.date,
          rollup,
          cachedAt: new Date().toISOString(),
        },
      }))
    );
  }
  await Promise.all(writes);

  return {
    daysWritten: rollups.size,
    paymentsScanned: payments.length,
    ticketsScanned: tickets.length,
  };
}

// ── Sync: Inventory (per-location stock from /inventory/values) ──────

async function syncInventory(secret: HeartlandSecret): Promise<{
  totalItems: number;
  totalQtyOnHand: number;
}> {
  // Fetch all items with stock at Flower Mound (location 100006)
  // Using the correct path: /inventory/values?group[]=item_id&group[]=location_id
  // with exclude_empty_locations=true to skip zero-stock items
  const allValues: HeartlandInventoryValue[] = [];
  let page = 1;
  const maxPages = 100; // 5,987 items / 200 per page = ~30 pages

  while (page <= maxPages) {
    const path = `inventory/values?group[]=item_id&group[]=location_id&exclude_empty_locations=true&~[location_id]=${FLOWER_MOUND_LOCATION_ID}`;
    const data = await fetchPage<HeartlandInventoryValue>(secret, path, page);
    if (!data.results || data.results.length === 0) break;
    allValues.push(...data.results);
    if (page >= (data.pages ?? 1)) break;
    page++;
  }

  // Also fetch item details for the items we have in stock
  // We'll embed cost/price from the items endpoint for margin analysis
  // Fetch items in batches using the item_ids we found
  const itemIds = [...new Set(allValues.map((v) => v.item_id).filter(Boolean))] as number[];

  // Fetch item details for cost/price/description (batch by filtering)
  // We'll fetch all active items and join — more reliable than per-item calls
  const itemDetails = new Map<number, {
    description: string;
    cost: number;
    price: number;
    public_id: string;
    brand: string;
    department: string;
  }>();

  // Fetch items in pages, only active ones
  let itemPage = 1;
  const maxItemPages = 400;
  while (itemPage <= maxItemPages) {
    const data = await fetchPage<{
      id: number;
      public_id: string;
      description: string;
      cost: number;
      price: number;
      'active?': boolean;
      custom: { brand?: string; department?: string };
    }>(secret, 'items?~[active]=true', itemPage);
    if (!data.results || data.results.length === 0) break;
    for (const item of data.results) {
      itemDetails.set(item.id, {
        description: item.description ?? '',
        cost: item.cost ?? 0,
        price: item.price ?? 0,
        public_id: item.public_id ?? '',
        brand: item.custom?.brand ?? '',
        department: item.custom?.department ?? '',
      });
    }
    if (itemPage >= (data.pages ?? 1)) break;
    itemPage++;
  }

  // Build enriched inventory records
  const stockItems = allValues
    .filter((v) => v.qty_on_hand > 0)
    .map((v) => {
      const detail = itemDetails.get(v.item_id!);
      const cost = detail?.cost ?? v.unit_cost ?? 0;
      const price = detail?.price ?? 0;
      const margin = price > 0 && cost > 0
        ? Math.round(((price - cost) / price) * 1000) / 10
        : null;
      return {
        item_id: v.item_id,
        sku: detail?.public_id ?? '',
        description: detail?.description ?? '',
        brand: detail?.brand ?? '',
        department: detail?.department ?? '',
        cost,
        price,
        margin,
        qty_on_hand: v.qty_on_hand,
        qty_available: v.qty_available,
        qty_committed: v.qty_committed,
        qty_on_po: v.qty_on_po,
        unit_cost: v.unit_cost,
      };
    });

  // Aggregations
  const byDepartment: Record<string, { count: number; totalCost: number; totalPrice: number; avgMargin: number; totalQty: number }> = {};
  const byBrand: Record<string, { count: number; totalQty: number }> = {};
  let totalQtyOnHand = 0;

  for (const item of stockItems) {
    totalQtyOnHand += item.qty_on_hand;
    const dept = item.department || 'Uncategorized';
    const brand = item.brand || 'Unknown';
    if (!byDepartment[dept]) byDepartment[dept] = { count: 0, totalCost: 0, totalPrice: 0, avgMargin: 0, totalQty: 0 };
    byDepartment[dept]!.count += 1;
    byDepartment[dept]!.totalCost += item.cost;
    byDepartment[dept]!.totalPrice += item.price;
    byDepartment[dept]!.totalQty += item.qty_on_hand;
    if (!byBrand[brand]) byBrand[brand] = { count: 0, totalQty: 0 };
    byBrand[brand]!.count += 1;
    byBrand[brand]!.totalQty += item.qty_on_hand;
  }
  for (const dept of Object.values(byDepartment)) {
    dept.avgMargin = dept.totalPrice > 0
      ? Math.round(((dept.totalPrice - dept.totalCost) / dept.totalPrice) * 1000) / 10
      : 0;
  }

  const withMargin = stockItems.filter((i) => i.margin !== null);
  const overallAvgMargin = withMargin.length > 0
    ? Math.round(withMargin.reduce((s, i) => s + (i.margin ?? 0), 0) / withMargin.length * 10) / 10
    : 0;

  const lowStockItems = stockItems
    .filter((i) => i.qty_on_hand > 0 && i.qty_on_hand <= 3)
    .sort((a, b) => {
      // Primary: qty ascending (most urgent first)
      if (a.qty_on_hand !== b.qty_on_hand) return a.qty_on_hand - b.qty_on_hand;
      // Secondary: brand alphabetical so no single brand dominates
      return (a.brand ?? '').localeCompare(b.brand ?? '');
    })
    .slice(0, 300); // raise cap — DynamoDB item is well under 400KB at this size

  const lowMarginItems = stockItems
    .filter((i) => i.margin !== null && i.margin < 20 && i.price > 0)
    .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0))
    .slice(0, 30);

  const topMarginItems = stockItems
    .filter((i) => i.margin !== null && i.price > 0)
    .sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0))
    .slice(0, 50);

  const data = {
    locationId: FLOWER_MOUND_LOCATION_ID,
    summary: {
      totalItems: stockItems.length,
      activeItems: stockItems.length,
      liveItems: stockItems.length,
      itemsWithCostData: withMargin.length,
      overallAvgMarginPct: overallAvgMargin,
      totalQtyOnHand,
    },
    byDepartment: Object.entries(byDepartment)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count),
    byBrand: Object.entries(byBrand)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30),
    topMarginItems,
    lowMarginItems,
    lowStockItems,
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: 'POS#INVENTORY#CATALOG',
      data,
      cachedAt: new Date().toISOString(),
    },
  }));

  return { totalItems: stockItems.length, totalQtyOnHand };
}

// ── Sync: Purchasing (vendors + recent orders) ───────────────────────

async function syncPurchasing(secret: HeartlandSecret): Promise<{
  vendorCount: number;
  orderCount: number;
}> {
  // Vendors
  const vendors: HeartlandVendor[] = [];
  let page = 1;
  while (page <= 10) {
    const data = await fetchPage<HeartlandVendor>(secret, 'purchasing/vendors', page);
    if (!data.results || data.results.length === 0) break;
    vendors.push(...data.results);
    if (page >= (data.pages ?? 1)) break;
    page++;
  }

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: 'POS#PURCHASING#VENDORS',
      vendors,
      cachedAt: new Date().toISOString(),
    },
  }));

  // Recent purchase orders (last 5 pages = ~1,000 most recent)
  const firstOPage = await fetchPage<HeartlandOrder>(secret, 'purchasing/orders', 1);
  const totalOPages = Math.ceil(firstOPage.total / 200);
  const startOPage = Math.max(1, totalOPages - 5);

  const orders: HeartlandOrder[] = [];
  for (let p = totalOPages; p >= startOPage; p--) {
    const data = await fetchPage<HeartlandOrder>(secret, 'purchasing/orders', p);
    orders.push(...data.results);
  }

  // Build vendor name map for display
  const vendorMap: Record<number, string> = {};
  for (const v of vendors) {
    if (v.name) vendorMap[v.id] = v.name;
  }

  const enrichedOrders = orders.map((o) => ({
    ...o,
    vendorName: o.vendor_id ? (vendorMap[o.vendor_id] ?? `Vendor ${o.vendor_id}`) : 'Unknown',
  }));

  // Compute vendor sales rank from ALL orders (total received qty = proxy for sales volume).
  // Fetch all order pages for the ranking calculation.
  const allOrders: HeartlandOrder[] = [...orders];
  for (let p = Math.max(1, startOPage - 1); p >= 1; p--) {
    const data = await fetchPage<HeartlandOrder>(secret, 'purchasing/orders', p);
    allOrders.push(...data.results);
  }

  const vendorReceivedQty: Record<number, number> = {};
  const vendorOpenOrders: Record<number, number> = {};
  const vendorTotalOrders: Record<number, number> = {};

  for (const o of allOrders) {
    if (!o.vendor_id) continue;
    vendorReceivedQty[o.vendor_id] = (vendorReceivedQty[o.vendor_id] ?? 0) + (o.total_received_qty ?? 0);
    vendorTotalOrders[o.vendor_id] = (vendorTotalOrders[o.vendor_id] ?? 0) + 1;
    if (o.status === 'open' || o.status === 'pending') {
      vendorOpenOrders[o.vendor_id] = (vendorOpenOrders[o.vendor_id] ?? 0) + 1;
    }
  }

  // Produce a ranked list: [{vendorId, vendorName, totalReceivedQty, openOrders, totalOrders, rank}]
  const vendorRank = vendors
    .map((v) => ({
      vendorId: v.id,
      vendorName: v.name ?? `Vendor ${v.id}`,
      totalReceivedQty: vendorReceivedQty[v.id] ?? 0,
      openOrders: vendorOpenOrders[v.id] ?? 0,
      totalOrders: vendorTotalOrders[v.id] ?? 0,
    }))
    .sort((a, b) => b.totalReceivedQty - a.totalReceivedQty)
    .map((v, i) => ({ ...v, rank: i + 1 }));

  // Only store open/pending orders — use allOrders (full history) so the
  // modal count matches the vendorRank.openOrders count exactly.
  // allOrders already contains every page; filter to open/pending only.
  const openOrders = allOrders
    .filter((o) => o.status === 'open' || o.status === 'pending')
    .map((o) => ({
      ...o,
      vendorName: o.vendor_id ? (vendorMap[o.vendor_id] ?? `Vendor ${o.vendor_id}`) : 'Unknown',
    }))
    .slice(0, 500); // DynamoDB 400KB limit — 500 orders is ~200KB

  // Store vendors + rank in one item, open orders in another (keeps each under 400KB)
  await Promise.all([
    docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#PURCHASING#VENDORS',
        vendors,
        vendorRank,
        cachedAt: new Date().toISOString(),
      },
    })),
    docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#PURCHASING#ORDERS',
        orders: openOrders,
        totalOrders: firstOPage.total,
        cachedAt: new Date().toISOString(),
      },
    })),
  ]);

  return { vendorCount: vendors.length, orderCount: openOrders.length };
}

// ── Sync: Reporting analyzer (net sales by date + by brand) ─────────

async function syncReporting(secret: HeartlandSecret): Promise<{ rows: number; monthRows: number; brandRows: number; returnRows: number; customerRows: number }> {
  // Use Central Time for "today" so the date ranges align with how Heartland
  // stores per-store sales (they use store-local time on tickets/payments).
  const STORE_TZ = 'America/Chicago';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmt.format(new Date());
  const thirtyDaysAgoDate = new Date();
  thirtyDaysAgoDate.setUTCDate(thirtyDaysAgoDate.getUTCDate() - 30);
  const thirtyDaysAgo = fmt.format(thirtyDaysAgoDate);
  const currentYear = parseInt(today.slice(0, 4), 10);
  const yearStart = `${currentYear}-01-01`;

  // Net sales by date — 30-day window. NOTE: omit net_margin metric — Heartland's
  // analyzer 500s when net_margin is combined with date.date grouping.
  const datePath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.date&start_date=${thirtyDaysAgo}&end_date=${today}`;

  // Monthly trend YTD. NOTE: same constraint as daily — omit net_margin or
  // Heartland's analyzer 500s on month_of_year + year grouping.
  const monthPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.month_of_year&groups[]=date.year&start_date=${yearStart}&end_date=${today}`;

  // Net sales by brand YTD — used for vendor ranking + YTD summary tiles.
  // NOTE: same constraint — net_margin combined with item.custom@brand 500s.
  // We drop it here and fetch margin separately from a brand-only query without
  // the brand grouping (handled below as a single aggregate).
  const brandPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.net_qty_sold&metrics[]=source_sales.transaction_count&groups[]=item.custom@brand&start_date=${yearStart}&end_date=${today}`;

  // YTD totals — group by date.year (single row per year in window) gives us
  // net_sales + transaction_count without margin. Heartland's analyzer 500s
  // on ANY net_margin query for this account/token (we tried every grouping
  // combination — date.date, date.month_of_year, date.year, item.custom@brand,
  // and ungrouped). Likely the token lacks read:reports/cost scope. Margin is
  // surfaced as "not available" in the UI when totalsRows lacks net_margin.
  const totalsPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.year&start_date=${yearStart}&end_date=${today}`;

  // Return rate by brand — gross_returns / gross_sales
  const returnPath = `reporting/analyzer?metrics[]=source_sales.gross_sales&metrics[]=source_sales.gross_returns&metrics[]=source_sales.gross_qty_sold&metrics[]=source_sales.gross_qty_returned&groups[]=item.custom@brand&start_date=${yearStart}&end_date=${today}`;

  // Customer repeat vs new — transaction count by customer
  const customerPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=customer.public_id&start_date=${yearStart}&end_date=${today}`;

  let dateRows: Array<Record<string, unknown>> = [];
  let monthRows: Array<Record<string, unknown>> = [];
  let brandRows: Array<Record<string, unknown>> = [];
  let returnRows: Array<Record<string, unknown>> = [];
  let customerRows: Array<Record<string, unknown>> = [];
  let totalsRows: Array<Record<string, unknown>> = [];

  const fetchReport = async (path: string, label: string) => {
    try {
      const data = await fetchPage<Record<string, unknown>>(secret, path, 1, 500);
      return data.results ?? [];
    } catch (err) {
      console.warn(`Reporting ${label} sync failed (non-fatal):`, (err as Error).message);
      return [];
    }
  };

  [dateRows, monthRows, brandRows, returnRows, customerRows, totalsRows] = await Promise.all([
    fetchReport(datePath, 'date'),
    fetchReport(monthPath, 'monthly'),
    fetchReport(brandPath, 'brand'),
    fetchReport(returnPath, 'returns'),
    fetchReport(customerPath, 'customers'),
    fetchReport(totalsPath, 'totals'),
  ]);

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: 'POS#REPORTING#SALES',
      rows: dateRows,
      monthRows,
      brandRows,
      returnRows,
      customerRows,
      totalsRows,
      fromDate: thirtyDaysAgo,
      toDate: today,
      yearStart,
      cachedAt: new Date().toISOString(),
    },
  }));

  // Also cache prior-year insights data so the Insights tab can switch between
  // years without re-querying Heartland on every request. We cache 4 years
  // back (current + 3 prior). All Time aggregates these in the user-facing handler.
  const yearsToCache = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear];
  for (const yr of yearsToCache) {
    const yStart = `${yr}-01-01`;
    const yEnd = yr === currentYear ? today : `${yr}-12-31`;
    // Same constraint as the main brand query — drop net_margin to avoid 500s.
    const yBrandPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.net_qty_sold&metrics[]=source_sales.transaction_count&groups[]=item.custom@brand&start_date=${yStart}&end_date=${yEnd}`;
    const yReturnPath = `reporting/analyzer?metrics[]=source_sales.gross_sales&metrics[]=source_sales.gross_returns&metrics[]=source_sales.gross_qty_sold&metrics[]=source_sales.gross_qty_returned&groups[]=item.custom@brand&start_date=${yStart}&end_date=${yEnd}`;
    const yCustomerPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=customer.public_id&start_date=${yStart}&end_date=${yEnd}`;
    // Per-year totals — grouped by year for a single aggregate row.
    // Excludes net_margin because Heartland's analyzer 500s on any margin query
    // for this token (likely a scope/permission issue). Margin is shown as
    // "not available" in the UI when these rows lack it.
    const yTotalsPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.year&start_date=${yStart}&end_date=${yEnd}`;

    const [yBrand, yReturn, yCustomer, yTotals] = await Promise.all([
      fetchReport(yBrandPath, `brand-${yr}`),
      fetchReport(yReturnPath, `return-${yr}`),
      fetchReport(yCustomerPath, `customer-${yr}`),
      fetchReport(yTotalsPath, `totals-${yr}`),
    ]);

    // Skip writing if we got no data (year before the store existed)
    if (yBrand.length === 0 && yReturn.length === 0 && yCustomer.length === 0 && yTotals.length === 0) continue;

    try {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: OWNER_USER_ID,
          sk: `POS#REPORTING#YEAR#${yr}`,
          year: yr,
          fromDate: yStart,
          toDate: yEnd,
          brandRows: yBrand,
          returnRows: yReturn,
          customerRows: yCustomer,
          totalsRows: yTotals,
          cachedAt: new Date().toISOString(),
        },
      }));
    } catch (err) {
      console.warn(`Year ${yr} cache write failed (non-fatal):`, (err as Error).message);
    }
  }

  return { rows: dateRows.length, monthRows: monthRows.length, brandRows: brandRows.length, returnRows: returnRows.length, customerRows: customerRows.length };
}

// ── Sync: Staff + Payment types ──────────────────────────────────────

async function syncStaffAndPaymentTypes(secret: HeartlandSecret): Promise<{
  userCount: number;
  paymentTypeCount: number;
}> {
  const [usersRes, ptRes] = await Promise.all([
    fetch(`${secret.baseUrl}/users?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } }),
    fetch(`${secret.baseUrl}/payment_types?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } }),
  ]);

  const users = usersRes.ok
    ? ((await usersRes.json()) as { results: HeartlandUser[] }).results ?? []
    : [];
  const types = ptRes.ok
    ? ((await ptRes.json()) as { results: Array<{ id: number; name: string }> }).results ?? []
    : [];

  await Promise.all([
    docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: 'POS#USERS#LIST', users, cachedAt: new Date().toISOString() },
    })),
    docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: 'POS#PAYMENT_TYPES#LIST', types, cachedAt: new Date().toISOString() },
    })),
  ]);

  return { userCount: users.length, paymentTypeCount: types.length };
}

async function writeSyncStatus(status: Record<string, unknown>): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { userId: OWNER_USER_ID, sk: 'POS#SYNC#STATUS', ...status, updatedAt: new Date().toISOString() },
  }));
}

// ── Sync: Customers (full directory pull) ────────────────────────────
//
// Pulls every customer from Heartland's /customers endpoint into DDB so
// the campaign card can filter / search without hitting the live API
// every page load. Writes one canonical row per customer plus a single
// rollup stats row.
//
// SK shape:
//   POS#CUSTOMER#<id>     — canonical row
//   POS#CUSTOMER_STATS    — count rollup (total, withEmail, optedIn, etc.)
//
// 28k+ customers → at 200 per_page that's ~140 pages. Fast at HL's
// current latency (~150ms/page). Total walltime ~25-40s.

interface HeartlandCustomer {
  id: number;
  public_id?: string;
  uuid?: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  'active?'?: boolean;
  'promotional_emails?'?: boolean;
  'promotional_messages?'?: boolean;
  loyalty_points_balance?: number;
  loyalty_points_total?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  custom?: Record<string, unknown>;
}

async function syncCustomers(secret: HeartlandSecret): Promise<{
  customersWritten: number;
  pagesPulled: number;
  totalReported: number;
  withEmail: number;
  optedIn: number;
  reachableEmails: number;
}> {
  const perPage = 200;
  let page = 1;
  let pagesPulled = 0;
  let customersWritten = 0;
  let withEmail = 0;
  let optedIn = 0;
  let reachableEmails = 0;
  let activeCount = 0;
  let totalReported = 0;
  // Bucket signups by month for trend charts.
  const signupsByMonth = new Map<string, number>();

  while (true) {
    const res = await fetchPage<HeartlandCustomer>(
      secret,
      'customers',
      page,
      perPage
    );
    pagesPulled++;
    if (page === 1) totalReported = res.total ?? 0;

    // Batch-write each page (DDB BatchWrite caps at 25 items per request).
    const items = res.results.map((c) => {
      // Track stats inline.
      const email = (c.email ?? '').trim();
      if (email) withEmail++;
      // Strict opt-in: only customers explicitly flagged true.
      const optedInStrict = email && c['promotional_emails?'] === true;
      if (optedInStrict) optedIn++;
      // Permissive reach: anyone with an email and not actively unsubscribed
      // via our app-level flag (which is set via the unsubscribe link in
      // any prior campaign — at sync time we don't know that yet, so
      // treat as 0). After at least one campaign goes out, the campaign
      // path's own filter is the authoritative count.
      if (email) reachableEmails++;
      if (c['active?']) activeCount++;
      if (c.created_at) {
        const month = c.created_at.slice(0, 7); // YYYY-MM
        signupsByMonth.set(month, (signupsByMonth.get(month) ?? 0) + 1);
      }

      const firstName = (c.first_name ?? '').trim();
      const lastName = (c.last_name ?? '').trim();
      const fullName =
        c.name?.trim() ||
        [firstName, lastName].filter(Boolean).join(' ').trim() ||
        '(no name)';

      return {
        userId: OWNER_USER_ID,
        sk: `POS#CUSTOMER#${c.id}`,
        // Canonical fields used by query / filter.
        customerId: c.id,
        publicId: c.public_id ?? null,
        firstName,
        lastName,
        name: fullName,
        nameLower: fullName.toLowerCase(),
        email: email,
        emailLower: email.toLowerCase(),
        phoneNumber: c.phone_number ?? null,
        active: c['active?'] ?? true,
        promotionalEmails:
          email && c['promotional_emails?'] !== false ? true : false,
        promotionalMessages: c['promotional_messages?'] === true,
        loyaltyBalance: c.loyalty_points_balance ?? 0,
        loyaltyTotal: c.loyalty_points_total ?? 0,
        createdAt: c.created_at ?? null,
        updatedAt: c.updated_at ?? null,
        deletedAt: c.deleted_at ?? null,
        signupMonth: c.created_at?.slice(0, 7) ?? null,
        // Unsubscribe state — flipped by GET /campaign/unsubscribe. Kept
        // separate from `promotionalEmails` so we can distinguish "vendor
        // says no" from "customer hit our unsubscribe link" when needed.
        unsubscribed: false,
      };
    });

    // Write in batches of 25.
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      try {
        await Promise.all(
          batch.map((item) =>
            docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))
          )
        );
        customersWritten += batch.length;
      } catch (err) {
        console.error('customer batch write failed:', (err as Error).message);
      }
    }

    if (page >= (res.pages ?? 1)) break;
    page++;
    // Safety cap — 200 pages * 200 per_page = 40k customers max.
    if (page > 200) break;
  }

  // Write rollup stats row.
  const monthEntries = [...signupsByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-24); // last 24 months for trend chart
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#CUSTOMER_STATS',
        totalCustomers: customersWritten,
        totalReported,
        withEmail,
        optedIn,
        reachableEmails,
        activeCount,
        signupsByMonth: monthEntries.map(([month, count]) => ({ month, count })),
        updatedAt: new Date().toISOString(),
      },
    })
  );

  return {
    customersWritten,
    pagesPulled,
    totalReported,
    withEmail,
    optedIn,
    reachableEmails,
  };
}

/**
 * Stamp every customer row with their `lastPurchaseAt` date by scanning
 * completed tickets from the last 24 months. Then aggregate dormancy
 * buckets (6m and 12m) into the stats row.
 *
 * Strategy:
 *   1. Pull all completed tickets `local_completed_at >= now - 24mo`
 *      with customer_id, take the max date per customer.
 *   2. UpdateItem each customer row with lastPurchaseAt.
 *   3. Re-scan customer rows to count dormancy buckets, write to stats.
 *
 * 28k customers + 24mo of tickets is large — typical store does
 * 8-12k tickets/year so ~16-24k tickets over 24mo. At 200 per_page that's
 * ~80-120 pages. Total wall clock ~30-60s. Stays under Lambda's 15min cap.
 */
async function syncCustomerRecency(
  secret: HeartlandSecret
): Promise<{
  ticketsScanned: number;
  customersStamped: number;
  dormant6m: number;
  dormant12m: number;
}> {
  // ── 1. Pull tickets ────────────────────────────────────────────────
  const STORE_TZ = 'America/Chicago';
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmtDate.format(new Date());

  // Heartland's sales/tickets endpoint returns HTTP 500 when asked to
  // page through 24 months in a single call (~16-24k records). Window
  // the query into 3-month chunks and merge the results — mirrors the
  // pattern syncPaymentsAndTickets uses for its 35-day window.
  // Filter operators MUST be prefixed with $ ($gte, $lte) to match
  // Heartland's documented JSON filter syntax — without the prefix
  // the endpoint silently misbehaves.
  const lastByCustomer = new Map<number, string>();
  let ticketsScanned = 0;

  // Build 8 windows of 3 months each, walking back from today.
  const windows: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < 8; i++) {
    const end = new Date();
    end.setMonth(end.getMonth() - 3 * i);
    const start = new Date();
    start.setMonth(start.getMonth() - 3 * (i + 1));
    windows.push({
      from: fmtDate.format(start),
      to: i === 0 ? today : fmtDate.format(end),
    });
  }

  for (const win of windows) {
    const filter = JSON.stringify({
      local_completed_at: {
        $gte: `${win.from}T00:00:00`,
        $lte: `${win.to}T23:59:59`,
      },
    });
    const ticketPath = `sales/tickets?_filter=${encodeURIComponent(filter)}`;
    let page = 1;
    while (true) {
      let res;
      try {
        res = await fetchPage<HeartlandTicket>(secret, ticketPath, page, 200);
      } catch (err) {
        console.warn(
          `Recency sync: window ${win.from}→${win.to} page ${page} failed: ${(err as Error).message}`
        );
        break;
      }
      for (const t of res.results) {
        // Filter client-side for completed (Heartland's tickets endpoint
        // doesn't accept those as filters — known bug).
        if (t['voided?']) continue;
        if (!t['completed?']) continue;
        const cid = t.customer_id;
        if (!cid) continue;
        const d = t.local_completed_at;
        if (!d) continue;
        const prev = lastByCustomer.get(cid);
        if (!prev || d > prev) lastByCustomer.set(cid, d);
        ticketsScanned++;
      }
      if (page >= (res.pages ?? 1)) break;
      page++;
      if (page > 200) break; // safety cap per window
    }
    console.log(
      `Recency window ${win.from}→${win.to}: scanned ${ticketsScanned} so far, ${lastByCustomer.size} distinct customers`
    );
  }

  // ── 2. Stamp customers in DDB ──────────────────────────────────────
  let customersStamped = 0;
  const ids = [...lastByCustomer.entries()];
  // Run updates in batches of 25 to bound concurrency.
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    await Promise.all(
      batch.map(async ([cid, date]) => {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: TABLE_NAME,
              Key: { userId: OWNER_USER_ID, sk: `POS#CUSTOMER#${cid}` },
              UpdateExpression:
                'SET lastPurchaseAt = :d, lastPurchaseStampedAt = :now',
              ExpressionAttributeValues: {
                ':d': date,
                ':now': new Date().toISOString(),
              },
              // Don't fail if the customer row doesn't exist — could
              // happen if the customer sync is stale.
              ConditionExpression: 'attribute_exists(sk)',
            })
          );
          customersStamped++;
        } catch (err) {
          // ConditionalCheckFailedException = customer row doesn't exist
          // (probably new customer not yet pulled). Silent skip.
          const e = err as { name?: string };
          if (e.name !== 'ConditionalCheckFailedException') {
            console.warn(
              `recency stamp failed for ${cid}:`,
              (err as Error).message
            );
          }
        }
      })
    );
  }

  // ── 3. Compute dormancy buckets and patch stats row ───────────────
  // We scan only the canonical customer rows once and count.
  const cutoff6m = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const cutoff12m = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return d.toISOString().slice(0, 10);
  })();

  let dormant6m = 0;
  let dormant12m = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  while (true) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: {
          ':u': OWNER_USER_ID,
          ':p': 'POS#CUSTOMER#',
        },
        ProjectionExpression: 'lastPurchaseAt, email',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of res.Items ?? []) {
      const last = item['lastPurchaseAt'] as string | undefined;
      const email = String(item['email'] ?? '').trim();
      // Only count customers WITH email — that's the campaign-relevant
      // population. Customers without email can't be reached either way.
      if (!email) continue;
      const lastDate = last ? last.slice(0, 10) : null;
      if (!lastDate || lastDate < cutoff12m) {
        dormant12m++;
      }
      if (!lastDate || lastDate < cutoff6m) {
        dormant6m++;
      }
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }

  // Patch the stats row with dormancy + cutoff dates so the UI can show.
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#CUSTOMER_STATS' },
      UpdateExpression:
        'SET dormant6m = :d6, dormant12m = :d12, dormancyCutoff6m = :c6, dormancyCutoff12m = :c12, recencyUpdatedAt = :now',
      ExpressionAttributeValues: {
        ':d6': dormant6m,
        ':d12': dormant12m,
        ':c6': cutoff6m,
        ':c12': cutoff12m,
        ':now': new Date().toISOString(),
      },
    })
  );

  return { ticketsScanned, customersStamped, dormant6m, dormant12m };
}



export const handler = async (event?: ScheduledEvent | { trigger?: string }) => {
  const start = Date.now();
  const trigger =
    'source' in (event ?? {}) && (event as ScheduledEvent).source === 'aws.events'
      ? 'schedule'
      : (event as { trigger?: string })?.trigger || 'manual';

  // "today-only" fast path — invoked synchronously from the FS Assistant
  // when a user asks about today's sales / now / current data. Only the
  // payments+tickets section runs (rolling 35-day window in
  // syncPaymentsAndTickets is already narrow; the other sections are
  // skipped to keep total wall-clock under ~10s).
  const todayOnly = trigger === 'today-only';
  // "customers-only" mode — invoked from the Campaign card's Refresh
  // button. Only the /customers pull runs (~25-40s for 28k customers).
  const customersOnly = trigger === 'customers-only';

  console.log(
    `Sync start: trigger=${trigger} todayOnly=${todayOnly} locationId=${FLOWER_MOUND_LOCATION_ID}`
  );
  const summary: Record<string, unknown> = {
    trigger,
    todayOnly,
    startedAt: new Date(start).toISOString(),
    locationId: FLOWER_MOUND_LOCATION_ID,
  };

  let secret: HeartlandSecret;
  try {
    secret = await getHeartlandSecret();
  } catch (err) {
    summary['error'] = `Secret load: ${(err as Error).message}`;
    await writeSyncStatus({ ...summary, status: 'error', durationMs: Date.now() - start });
    return summary;
  }

  // Run each sync section independently so partial failures don't block others.
  // Today-only mode runs only payments/tickets — that's the data backing
  // get_sales_summary's "today" bucket. Customers-only mode runs only
  // the /customers pull (admin-triggered from the Campaign Refresh button).
  const sections: Array<[string, () => Promise<unknown>]> = todayOnly
    ? [['payments', () => syncPaymentsAndTickets(secret)]]
    : customersOnly
      ? [
          ['customers', () => syncCustomers(secret)],
          ['customerRecency', () => syncCustomerRecency(secret)],
        ]
      : [
          ['payments', () => syncPaymentsAndTickets(secret)],
          ['inventory', () => syncInventory(secret)],
          ['purchasing', () => syncPurchasing(secret)],
          ['reporting', () => syncReporting(secret)],
          ['staff', () => syncStaffAndPaymentTypes(secret)],
          ['customers', () => syncCustomers(secret)],
          ['customerRecency', () => syncCustomerRecency(secret)],
        ];
  for (const [name, fn] of sections) {
    try {
      const t0 = Date.now();
      const result = await fn();
      summary[name] = { ...(result as object), durationMs: Date.now() - t0 };
    } catch (err) {
      console.error(`Sync section ${name} failed:`, (err as Error).message);
      summary[name] = { error: (err as Error).message };
    }
  }

  const durationMs = Date.now() - start;
  summary['durationMs'] = durationMs;
  summary['completedAt'] = new Date().toISOString();
  // Mark the overall status based on whether any section reported an
  // error. Without this the UI's "Synced N min ago" badge stays green
  // even when Heartland's API was returning 500s for a critical
  // section like payments — which leaves the dashboard showing stale
  // numbers without warning the user.
  const anyError = sections.some(([name]) => {
    const s = summary[name] as { error?: unknown } | undefined;
    return s && typeof s === 'object' && 'error' in s && s.error;
  });
  const allError = sections.every(([name]) => {
    const s = summary[name] as { error?: unknown } | undefined;
    return s && typeof s === 'object' && 'error' in s && s.error;
  });
  summary['status'] = allError ? 'error' : anyError ? 'partial' : 'ok';

  await writeSyncStatus(summary);
  console.log(`Sync complete in ${durationMs}ms:`, JSON.stringify(summary));
  return summary;
};
