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
  total_discounts: number;
  completed_at: string | null;
  local_completed_at: string | null;
  customer_name: string | null;
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

  // Payments — filter by completed_at date range so we never miss a day
  // regardless of how many total records exist in the account.
  // sort=completed_at sorts ascending; we want newest-first for efficiency
  // but the date filter is what guarantees completeness.
  const paymentPath = `payments?sort=completed_at&completed_at[gte]=${fromDate}&completed_at[lte]=${today}`;
  const firstPage = await fetchPage<HeartlandPayment>(secret, paymentPath, 1);
  const totalPages = Math.ceil(firstPage.total / 200);

  const payments: HeartlandPayment[] = [...firstPage.results];
  for (let p = 2; p <= totalPages; p++) {
    const data = await fetchPage<HeartlandPayment>(secret, paymentPath, p);
    payments.push(...data.results);
  }

  // Tickets — same date-filtered approach for enrichment (discounts, customers, reps)
  const ticketPath = `sales/tickets?completed_at[gte]=${fromDate}&completed_at[lte]=${today}`;
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
        byPaymentType: {}, byHour: {}, topCustomers: {}, bySalesRep: {},
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

// ── Main handler ─────────────────────────────────────────────────────

export const handler = async (event?: ScheduledEvent | { trigger?: string }) => {
  const start = Date.now();
  const trigger =
    'source' in (event ?? {}) && (event as ScheduledEvent).source === 'aws.events'
      ? 'schedule'
      : (event as { trigger?: string })?.trigger || 'manual';

  console.log(`Sync start: trigger=${trigger} locationId=${FLOWER_MOUND_LOCATION_ID}`);
  const summary: Record<string, unknown> = {
    trigger,
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

  // Run each sync section independently so partial failures don't block others
  for (const [name, fn] of [
    ['payments', () => syncPaymentsAndTickets(secret)],
    ['inventory', () => syncInventory(secret)],
    ['purchasing', () => syncPurchasing(secret)],
    ['reporting', () => syncReporting(secret)],
    ['staff', () => syncStaffAndPaymentTypes(secret)],
  ] as Array<[string, () => Promise<unknown>]>) {
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
  summary['status'] = 'ok';

  await writeSyncStatus(summary);
  console.log(`Sync complete in ${durationMs}ms:`, JSON.stringify(summary));
  return summary;
};
