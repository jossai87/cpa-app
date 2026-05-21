/**
 * Heartland Retail POS integration Lambda — user-facing read-only handler.
 *
 * All Heartland API calls happen in the `foot-solutions-pos-sync` Lambda
 * (scheduled every 6h via EventBridge). This handler only reads from the
 * DynamoDB cache, so every endpoint responds in well under 500ms.
 *
 * Routes:
 *   GET /pos/dashboard           → today / WTD / MTD / YTD revenue snapshot
 *   GET /pos/sales?year=2026     → sum of all payments in a year
 *   GET /pos/import-tax-defaults?taxYear=2026
 *                                → returns ready-to-merge TaxFormData fields
 *   GET /pos/analytics?days=90   → daily trend, payment methods, top customers,
 *                                   hourly heatmap, discount analysis
 *   GET /pos/inventory           → cached item catalog with cost/price/margin
 *   GET /pos/staff               → sales by rep from cached rollups
 *   GET /pos/sync-status         → last sync info (when, durations, counts)
 *   POST /pos/sync               → trigger a manual sync (async, returns 202)
 *   GET /pos/vendor-settings     → persisted vendor account flags + overrides
 *   PUT /pos/vendor-settings     → save vendor account flags + overrides
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({ region: 'us-east-1' });

const TABLE_NAME = process.env['TABLE_NAME']!;
const SYNC_FUNCTION_NAME = process.env['SYNC_FUNCTION_NAME'] ?? '';
// All cache records live under this fixed userId (set by sync Lambda too).
// The sync Lambda runs from EventBridge with no user context, so we share one
// partition for the single-owner store.
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;

// ── Types ────────────────────────────────────────────────────────────

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

interface InventoryCacheData {
  summary: {
    totalItems: number;
    activeItems: number;
    liveItems: number;
    itemsWithCostData: number;
    overallAvgMarginPct: number;
  };
  byDepartment: Array<{ name: string; count: number; totalCost: number; totalPrice: number; avgMargin: number }>;
  byBrand: Array<{ name: string; count: number; totalRevenue: number }>;
  topMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number; brand: string; department: string }>;
  lowMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number }>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// All "today / N-days-ago" calculations use America/Chicago (Central Time).
// Heartland's local_completed_at is already in store-local (Central) time,
// so the rollup keys (POS#DAILY#YYYY-MM-DD) are Central dates. We must compute
// "today" the same way to align — otherwise, around midnight Central, the
// dashboard would show the wrong day's totals.
const STORE_TIMEZONE = 'America/Chicago';

const HEARTLAND_EXTENSION_BASE_URL = 'http://localhost:2773';

interface HeartlandSecret {
  token: string;
  subdomain: string;
  baseUrl: string;
}

async function getHeartlandSecret(): Promise<HeartlandSecret> {
  const url = `${HEARTLAND_EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent('foot-solutions/heartland/api-token')}`;
  const res = await fetch(url, {
    headers: { 'X-Aws-Parameters-Secrets-Token': process.env['AWS_SESSION_TOKEN'] ?? '' },
  });
  if (!res.ok) throw new Error(`Failed to load Heartland secret: ${res.status}`);
  const data = (await res.json()) as { SecretString: string };
  return JSON.parse(data.SecretString) as HeartlandSecret;
}

async function fetchFromHeartland<T>(path: string): Promise<T> {
  const secret = await getHeartlandSecret();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${secret.baseUrl}/${path}${sep}per_page=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secret.token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Heartland ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function centralDateString(d: Date): string {
  // Returns YYYY-MM-DD in Central Time regardless of where the Lambda runs.
  // Uses Intl.DateTimeFormat which is part of Node.js's full-icu support.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d); // en-CA gives "YYYY-MM-DD" formatting
}

function todayStr(): string {
  return centralDateString(new Date());
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return centralDateString(d);
}

async function queryDailyRollups(fromDate: string, toDate: string): Promise<DailyRollup[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':uid': OWNER_USER_ID,
        ':from': `POS#DAILY#${fromDate}`,
        ':to': `POS#DAILY#${toDate}`,
      },
    })
  );
  return (result.Items ?? []).map((item) => item['rollup'] as DailyRollup);
}

function sumRollups(rollups: DailyRollup[]): { totalAmount: number; ticketCount: number } {
  let totalAmount = 0;
  let ticketCount = 0;
  for (const r of rollups) {
    totalAmount += r.totalAmount;
    ticketCount += r.count;
  }
  return { totalAmount, ticketCount };
}

async function getSyncStatus(): Promise<Record<string, unknown> | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#SYNC#STATUS' },
    })
  );
  return r.Item ?? null;
}

// ── Route handlers ───────────────────────────────────────────────────

// Aggregate hourly totals from a set of rollups into a 24-element array
function buildHourlyTotals(rollups: DailyRollup[]): number[] {
  const hours = Array(24).fill(0) as number[];
  for (const r of rollups) {
    for (const [h, amt] of Object.entries(r.byHour ?? {})) {
      const idx = parseInt(h, 10);
      if (idx >= 0 && idx < 24) hours[idx] = (hours[idx] ?? 0) + (amt as number);
    }
  }
  return hours;
}

// Compute avg units sold per ticket and total units from rollups
// (units are not stored in daily rollups — we return ticket count as proxy)
function sumRollupsExtended(rollups: DailyRollup[]): {
  totalAmount: number;
  ticketCount: number;
} {
  return sumRollups(rollups);
}

async function handleDashboard(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const today = todayStr();
  const year = today.slice(0, 4);
  const lastYear = String(parseInt(year, 10) - 1);

  // Accept optional start/end params for custom date range filtering
  const paramStart = event.queryStringParameters?.['start'];
  const paramEnd = event.queryStringParameters?.['end'];

  // Validate date format if provided
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const rangeStart = paramStart && dateRe.test(paramStart) ? paramStart : null;
  const rangeEnd = paramEnd && dateRe.test(paramEnd) ? paramEnd : null;

  // ── Primary period ────────────────────────────────────────────────
  // When a custom range is provided, use it. Otherwise fall back to the
  // standard rolling windows (today / 7d / 30d / YTD).
  const effectiveStart = rangeStart ?? daysAgo(30);
  const effectiveEnd = rangeEnd ?? today;

  // Fetch the primary range + always fetch YTD for the YTD card
  const yearStart = `${year}-01-01`;
  const [rangeRollups, ytd] = await Promise.all([
    queryDailyRollups(effectiveStart, effectiveEnd),
    queryDailyRollups(yearStart, today),
  ]);

  // Derive sub-windows from the primary range
  const todayRollups = rangeRollups.filter((r) => r.date === today);
  const last7Rollups = rangeRollups.filter((r) => r.date >= daysAgo(7));
  const last30Rollups = rangeRollups.filter((r) => r.date >= daysAgo(30));

  // ── Same period last year ─────────────────────────────────────────
  // Shift the effective range back exactly one year for comparison.
  function shiftYearBack(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setFullYear(d.getFullYear() - 1);
    return centralDateString(d);
  }
  const lyStart = shiftYearBack(effectiveStart);
  const lyEnd = shiftYearBack(effectiveEnd);
  const lastYearToday = shiftYearBack(today);
  const lastYearStart = `${lastYear}-01-01`;

  const [lyRangeRollups, lyYtd, lyTodayRollups] = await Promise.all([
    queryDailyRollups(lyStart, lyEnd),
    queryDailyRollups(lastYearStart, lastYearToday),
    queryDailyRollups(lastYearToday, lastYearToday),
  ]);

  const lyLast7Start = shiftYearBack(daysAgo(7));
  const lyLast30Start = shiftYearBack(daysAgo(30));
  const lyLast7 = lyRangeRollups.filter((r) => r.date >= lyLast7Start);
  const lyLast30 = lyRangeRollups.filter((r) => r.date >= lyLast30Start);

  // ── Hourly breakdown for the Net Sales by Hour chart ─────────────
  // Use today vs same day last year regardless of range filter
  const todayHourly = buildHourlyTotals(todayRollups.length ? todayRollups : rangeRollups.filter((r) => r.date === effectiveEnd));
  const lastYearTodayHourly = buildHourlyTotals(lyTodayRollups);

  // ── Alerts ────────────────────────────────────────────────────────
  const [purchasingResult, inventoryResult] = await Promise.all([
    docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#ORDERS' } })),
    docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#INVENTORY#CATALOG' } })),
  ]);
  const openOrderCount = (purchasingResult.Item?.['vendorRank'] as Array<{ openOrders?: number }> | undefined)
    ?.reduce((s, r) => s + (r.openOrders ?? 0), 0) ?? 0;
  const lowStockCount = ((inventoryResult.Item?.['data'] as Record<string, unknown> | undefined)?.['lowStockItems'] as unknown[] | undefined)?.length ?? 0;

  const status = await getSyncStatus();

  // ── Selected range summary (used by KPI cards when a custom range is active)
  const selectedRange = sumRollupsExtended(rangeRollups);
  const lySelectedRange = sumRollupsExtended(lyRangeRollups);

  return json(200, {
    // Standard rolling windows (always present for goal tracker)
    today: sumRollupsExtended(todayRollups),
    last7Days: sumRollupsExtended(last7Rollups),
    last30Days: sumRollupsExtended(last30Rollups),
    yearToDate: sumRollupsExtended(ytd),
    // Selected range (equals one of the above when no custom range)
    selectedRange,
    selectedRangeStart: effectiveStart,
    selectedRangeEnd: effectiveEnd,
    lastYear: {
      today: sumRollupsExtended(lyTodayRollups),
      last7Days: sumRollupsExtended(lyLast7),
      last30Days: sumRollupsExtended(lyLast30),
      yearToDate: sumRollupsExtended(lyYtd),
      selectedRange: lySelectedRange,
    },
    hourly: {
      today: todayHourly,
      lastYear: lastYearTodayHourly,
    },
    alerts: {
      openOrders: openOrderCount,
      lowStock: lowStockCount,
    },
    syncInfo: {
      lastSyncAt: status?.['completedAt'] ?? null,
      status: status?.['status'] ?? 'never',
    },
    asOf: new Date().toISOString(),
  });
}

async function handleSalesByYear(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const yearStr = event.queryStringParameters?.['year'];
  const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  if (!year || year < 2020 || year > 2099) {
    return json(400, { error: 'Invalid year parameter' });
  }
  const rollups = await queryDailyRollups(`${year}-01-01`, `${year}-12-31`);
  const totals = sumRollups(rollups);
  return json(200, {
    year,
    totalRevenue: totals.totalAmount,
    ticketCount: totals.ticketCount,
    daysWithSales: rollups.length,
  });
}

async function handleImportTaxDefaults(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const yearStr = event.queryStringParameters?.['taxYear'];
  const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  if (!year || year < 2020 || year > 2099) {
    return json(400, { error: 'Invalid taxYear parameter' });
  }
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string;

  // ── 1. Daily payment rollups for the requested year ─────────────────
  // These give us the unfiltered total cash that came in (revenue + tax).
  const rollups = await queryDailyRollups(`${year}-01-01`, `${year}-12-31`);
  const grossWithTax = rollups.reduce((s, r) => s + r.totalAmount, 0);
  const ticketCount = rollups.reduce((s, r) => s + r.count, 0);
  const totalDiscounts = rollups.reduce((s, r) => s + (r.totalDiscounts ?? 0), 0);
  const taxableBasis = grossWithTax / 1.0825;
  const salesTaxCollected = grossWithTax - taxableBasis;

  // Aggregate payment-type spread for the report
  const paymentTypeTotals: Record<string, { count: number; amount: number }> = {};
  for (const r of rollups) {
    for (const [pt, v] of Object.entries(r.byPaymentType ?? {})) {
      if (!paymentTypeTotals[pt]) paymentTypeTotals[pt] = { count: 0, amount: 0 };
      paymentTypeTotals[pt]!.count += v.count;
      paymentTypeTotals[pt]!.amount += v.amount;
    }
  }
  // Resolve payment-type IDs to friendly labels
  const ptResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#PAYMENT_TYPES#LIST' },
    })
  );
  const ptList =
    (ptResult.Item?.['types'] as Array<{ id: number; name: string }> | undefined) ?? [];
  const ptLabel: Record<string, string> = {};
  for (const p of ptList) ptLabel[String(p.id)] = p.name;
  const paymentMix = Object.entries(paymentTypeTotals)
    .map(([id, v]) => ({
      name: ptLabel[id] ?? id,
      count: v.count,
      amount: Math.round(v.amount * 100) / 100,
    }))
    .sort((a, b) => b.amount - a.amount);

  // ── 2. Reporting analyzer per-year cache (richer signal) ────────────
  // The sync Lambda writes POS#REPORTING#YEAR#YYYY with brandRows,
  // returnRows, customerRows. From these we derive:
  //   - net sales (after discounts/returns)            → tax-ready revenue
  //   - net margin                                     → COGS via subtraction
  //   - top brand mix                                  → reference info
  let netSales: number | null = null;
  let netMargin: number | null = null;
  let netQtySold: number | null = null;
  let cogsEstimate: number | null = null;
  let topBrands: Array<{ brand: string; netSales: number; netMargin: number }> = [];
  const reportingYear = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: `POS#REPORTING#YEAR#${year}` },
    })
  );
  if (reportingYear.Item) {
    type Row = Record<string, unknown>;
    const brandRows = (reportingYear.Item['brandRows'] as Row[] | undefined) ?? [];
    const totalsRows = (reportingYear.Item['totalsRows'] as Row[] | undefined) ?? [];

    // Prefer the dedicated totals aggregate (has net_margin); fall back to
    // summing brand rows for net_sales/qty (margin will be 0 in that case).
    if (totalsRows.length > 0) {
      netSales = totalsRows.reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0);
      netMargin = totalsRows.reduce((s, r) => s + ((r['source_sales.net_margin'] as number) ?? 0), 0);
    } else {
      netSales = 0;
      netMargin = 0;
      for (const r of brandRows) {
        netSales += (r['source_sales.net_sales'] as number) ?? 0;
        netMargin += (r['source_sales.net_margin'] as number) ?? 0;
      }
    }
    netQtySold = 0;
    for (const r of brandRows) {
      netQtySold += (r['source_sales.net_qty_sold'] as number) ?? 0;
    }
    cogsEstimate = netMargin > 0 ? Math.max(0, netSales - netMargin) : null;
    // Merge case-insensitively (NAOT vs naot) to a single bucket
    const merged = new Map<string, { brand: string; netSales: number; netMargin: number }>();
    for (const r of brandRows) {
      const raw = ((r['item.custom@brand'] as string | undefined) ?? '').trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      let m = merged.get(key);
      if (!m) {
        m = { brand: raw, netSales: 0, netMargin: 0 };
        merged.set(key, m);
      }
      m.netSales += (r['source_sales.net_sales'] as number) ?? 0;
      m.netMargin += (r['source_sales.net_margin'] as number) ?? 0;
    }
    topBrands = Array.from(merged.values())
      .sort((a, b) => b.netSales - a.netSales)
      .slice(0, 15)
      .map((b) => ({
        brand: b.brand,
        netSales: Math.round(b.netSales * 100) / 100,
        netMargin: Math.round(b.netMargin * 100) / 100,
      }));
  }

  // ── 3. Inventory snapshot — for ending-inventory cost reference ─────
  // Only meaningful for the current year. Uses cached values from the
  // most recent inventory sync.
  const currentYear = parseInt(todayStr().slice(0, 4), 10);
  let endingInventoryCost: number | null = null;
  if (year === currentYear) {
    const invResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: 'POS#INVENTORY#CATALOG' },
      })
    );
    if (invResult.Item) {
      const byDept =
        (invResult.Item['byDepartment'] as Array<{ totalCost: number }> | undefined) ?? [];
      const totalCost = byDept.reduce((s, d) => s + (d.totalCost ?? 0), 0);
      if (totalCost > 0) endingInventoryCost = Math.round(totalCost * 100) / 100;
    }
  }

  // ── 4. Build the response ───────────────────────────────────────────
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Prefer reporting-analyzer net sales if available (more accurate); fall
  // back to the reverse-calculated taxable basis from payments.
  const totalRevenueImported = netSales != null ? round2(netSales) : round2(taxableBasis);

  const importedFields: Record<string, number> = {
    totalRevenue: totalRevenueImported,
    salesTaxCollected: round2(salesTaxCollected),
  };
  if (cogsEstimate != null && cogsEstimate > 0) {
    importedFields['cogs'] = round2(cogsEstimate);
  }
  if (endingInventoryCost != null) {
    importedFields['endingInventory'] = endingInventoryCost;
  }

  const generatedAt = new Date().toISOString();
  const summary = {
    taxYear: year,
    source: 'heartland',
    generatedAt,
    importedFields,
    metadata: {
      grossPaymentsIncludingTax: round2(grossWithTax),
      assumedTaxRate: 0.0825,
      ticketCount,
      daysWithSales: rollups.length,
      totalDiscounts: round2(totalDiscounts),
      netSales: netSales != null ? round2(netSales) : null,
      netMargin: netMargin != null ? round2(netMargin) : null,
      netQtySold,
      cogsEstimate: cogsEstimate != null ? round2(cogsEstimate) : null,
      avgMarginPct:
        netSales != null && netMargin != null && netSales > 0
          ? Math.round((netMargin / netSales) * 1000) / 10
          : null,
      endingInventoryCost,
      paymentMix,
      topBrands,
      reportingDataAvailable: netSales != null,
      inventoryDataAvailable: endingInventoryCost != null,
    },
    note:
      netSales != null
        ? 'totalRevenue uses Heartland Reporting Analyzer net sales (after discounts and returns) — matches what your CPA expects.'
        : 'totalRevenue is reverse-calculated from gross payments at 8.25% Denton combined rate. For exact figures, use sales tax returns or the Heartland Reporting Analyzer once it has synced for this year.',
  };

  // ── 5. Persist as a synthetic document so it shows up in the
  //       documents sidebar AND gets bundled into the CPA package ─────
  const docId = uuidv4();
  const fileName = `POS Import — Tax Year ${year} (${generatedAt.slice(0, 10)})`;
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId,
          sk: `DOC#${generatedAt}#${docId}`,
          docId,
          objectKey: `pos-import/${userId}/${docId}.json`, // synthetic — no real S3 object
          fileName,
          docType: 'pos-import',
          contentType: 'application/json',
          uploadedAt: generatedAt,
          // appliedTotals lets the form-hydration logic pick up these fields
          // automatically next visit (only if the user emptied them)
          appliedTotals: importedFields,
          flagged: [],
          bankName: null,
          periodStart: `${year}-01-01`,
          periodEnd: `${year}-12-31`,
          confidence: 'high',
          notes: summary.note,
          autoClassified: false,
          autoClassifyResult: null,
          // Embed the rich summary so the CPA package can include it as a
          // standalone JSON file. Stored inline since DynamoDB items can be up
          // to 400KB and this payload is tiny (a few KB at most).
          posImportSummary: summary,
        },
      })
    );
  } catch (err) {
    // Don't fail the import if the document write fails — the form still gets
    // its values. Surface the issue in the response so the UI can warn.
    console.error('Failed to persist POS-import doc:', (err as Error).message);
    return json(200, {
      ...summary,
      docPersisted: false,
      docPersistError: (err as Error).message,
    });
  }

  return json(200, {
    ...summary,
    docId,
    docPersisted: true,
  });
}

async function handleAnalytics(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const daysParam = event.queryStringParameters?.['days'];
  const days = Math.min(365, Math.max(1, parseInt(daysParam ?? '90', 10)));
  const today = todayStr();
  const fromDate = daysAgo(days);
  const rollups = await queryDailyRollups(fromDate, today);

  // Look up payment-type names from cache
  const ptResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#PAYMENT_TYPES#LIST' },
    })
  );
  const paymentTypes = (ptResult.Item?.['types'] as Array<{ id: number; name: string }>) ?? [];
  const ptMap: Record<string, string> = {};
  for (const pt of paymentTypes) ptMap[String(pt.id)] = pt.name;

  // Aggregate
  const paymentTotals: Record<string, { amount: number; count: number }> = {};
  const hourTotals: Record<string, number> = {};
  const customerTotals: Record<string, { amount: number; visits: number }> = {};
  const repTotals: Record<string, { amount: number; count: number }> = {};
  let totalDiscounts = 0;
  let totalAmount = 0;
  let totalCount = 0;

  for (const r of rollups) {
    totalAmount += r.totalAmount;
    totalCount += r.count;
    totalDiscounts += r.totalDiscounts ?? 0;
    for (const [typeId, v] of Object.entries(r.byPaymentType)) {
      if (!paymentTotals[typeId]) paymentTotals[typeId] = { amount: 0, count: 0 };
      paymentTotals[typeId]!.amount += v.amount;
      paymentTotals[typeId]!.count += v.count;
    }
    for (const [hour, amt] of Object.entries(r.byHour ?? {})) {
      hourTotals[hour] = (hourTotals[hour] ?? 0) + amt;
    }
    for (const [name, amt] of Object.entries(r.topCustomers ?? {})) {
      if (!customerTotals[name]) customerTotals[name] = { amount: 0, visits: 0 };
      customerTotals[name]!.amount += amt;
      customerTotals[name]!.visits += 1;
    }
    for (const [rep, amt] of Object.entries(r.bySalesRep ?? {})) {
      if (!repTotals[rep]) repTotals[rep] = { amount: 0, count: 0 };
      repTotals[rep]!.amount += amt;
      repTotals[rep]!.count += 1;
    }
  }

  const dailyTrend = rollups
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ date: r.date, amount: r.totalAmount, count: r.count }));

  const paymentMethods = Object.entries(paymentTotals)
    .map(([id, v]) => ({
      id,
      name: ptMap[id] ?? `Type ${id}`,
      amount: Math.round(v.amount * 100) / 100,
      count: v.count,
      pct: totalAmount > 0 ? Math.round((v.amount / totalAmount) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const hourlyHeatmap = Array.from({ length: 24 }, (_, i) => {
    const h = String(i).padStart(2, '0');
    const label = `${i === 0 ? 12 : i > 12 ? i - 12 : i}${i < 12 ? 'am' : 'pm'}`;
    return { hour: i, label, amount: Math.round((hourTotals[h] ?? 0) * 100) / 100 };
  });

  const topCustomers = Object.entries(customerTotals)
    .filter(([name]) => name && name !== 'null')
    .map(([name, v]) => ({ name, amount: Math.round(v.amount * 100) / 100, visits: v.visits }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20);

  const bySalesRep = Object.entries(repTotals)
    .map(([name, v]) => ({ name, amount: Math.round(v.amount * 100) / 100, count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  const status = await getSyncStatus();

  return json(200, {
    days,
    fromDate,
    toDate: today,
    summary: {
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalCount,
      avgTicket: totalCount > 0 ? Math.round((totalAmount / totalCount) * 100) / 100 : 0,
    },
    dailyTrend,
    paymentMethods,
    hourlyHeatmap,
    topCustomers,
    bySalesRep,
    discountSummary: {
      totalDiscounts: Math.round(totalDiscounts * 100) / 100,
      discountRate: totalAmount > 0 ? Math.round((totalDiscounts / (totalAmount + totalDiscounts)) * 1000) / 10 : 0,
      avgDiscountPerTicket: totalCount > 0 ? Math.round((totalDiscounts / totalCount) * 100) / 100 : 0,
    },
    syncInfo: {
      lastSyncAt: status?.['completedAt'] ?? null,
      status: status?.['status'] ?? 'never',
    },
    asOf: new Date().toISOString(),
  });
}

async function handleInventory(): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#INVENTORY#CATALOG' },
    })
  );
  if (!result.Item) {
    return json(200, {
      summary: { totalItems: 0, activeItems: 0, liveItems: 0, itemsWithCostData: 0, overallAvgMarginPct: 0, totalQtyOnHand: 0 },
      byDepartment: [],
      byBrand: [],
      topMarginItems: [],
      lowMarginItems: [],
      lowStockItems: [],
      cached: false,
      cachedAt: null,
      notReady: true,
      message: 'Inventory has not been synced yet. Use the "Sync now" button to populate.',
    });
  }
  const data = result.Item['data'] as Record<string, unknown>;
  return json(200, {
    ...data,
    cached: true,
    cachedAt: result.Item['cachedAt'],
  });
}

async function handleStaff(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  // Period selector: today, 7d, 30d, ytd, custom (with start/end)
  const period = event.queryStringParameters?.['period'] ?? 'ytd';
  const customStart = event.queryStringParameters?.['start'];
  const customEnd = event.queryStringParameters?.['end'];

  const today = todayStr();
  let fromDate: string;
  let toDate = today;
  let label: string;

  switch (period) {
    case 'today':
      fromDate = today;
      label = 'Today';
      break;
    case '7d':
      fromDate = daysAgo(6); // includes today = 7 days
      label = 'Last 7 days';
      break;
    case '30d':
      fromDate = daysAgo(29);
      label = 'Last 30 days';
      break;
    case 'monthly':
      fromDate = `${today.slice(0, 7)}-01`;
      label = 'This month';
      break;
    case 'custom':
      if (!customStart || !customEnd) {
        return json(400, { error: 'Custom period requires start and end query params (YYYY-MM-DD)' });
      }
      // Basic validation
      if (!/^\d{4}-\d{2}-\d{2}$/.test(customStart) || !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
        return json(400, { error: 'Dates must be in YYYY-MM-DD format' });
      }
      fromDate = customStart;
      toDate = customEnd;
      label = `${customStart} – ${customEnd}`;
      break;
    case 'ytd':
    default:
      fromDate = `${today.slice(0, 4)}-01-01`;
      label = 'Year to date';
      break;
  }

  // Read user names from cache
  const usersResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#USERS#LIST' },
    })
  );
  const users = (usersResult.Item?.['users'] as Array<{
    id: number;
    login: string;
    first_name: string;
    last_name: string;
  }>) ?? [];
  const userMap: Record<string, string> = {};
  for (const u of users) {
    const fullName = `${u.first_name} ${u.last_name}`.trim();
    userMap[u.login] = fullName || u.login;
    userMap[fullName] = fullName;
  }

  const rollups = await queryDailyRollups(fromDate, toDate);

  const repTotals: Record<string, { amount: number; days: number }> = {};
  for (const r of rollups) {
    for (const [rep, amt] of Object.entries(r.bySalesRep ?? {})) {
      if (!repTotals[rep]) repTotals[rep] = { amount: 0, days: 0 };
      repTotals[rep]!.amount += amt;
      repTotals[rep]!.days += 1;
    }
  }

  const staff = Object.entries(repTotals)
    .map(([rep, v]) => ({
      name: userMap[rep] ?? rep,
      rawName: rep,
      amount: Math.round(v.amount * 100) / 100,
      activeDays: v.days,
      avgPerDay: v.days > 0 ? Math.round((v.amount / v.days) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const status = await getSyncStatus();

  return json(200, {
    period,
    label,
    fromDate,
    toDate,
    staff,
    totalUsers: users.length,
    syncInfo: {
      lastSyncAt: status?.['completedAt'] ?? null,
      status: status?.['status'] ?? 'never',
    },
    asOf: new Date().toISOString(),
  });
}

async function handlePurchasing(): Promise<APIGatewayProxyResultV2> {
  const [vendorsResult, ordersResult] = await Promise.all([
    docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#VENDORS' } })),
    docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#PURCHASING#ORDERS' } })),
  ]);

  if (!vendorsResult.Item && !ordersResult.Item) {
    return json(200, {
      vendors: [],
      vendorRank: [],
      orders: [],
      totalOrders: 0,
      notReady: true,
      message: 'Purchasing data has not been synced yet.',
    });
  }

  const vendors = (vendorsResult.Item?.['vendors'] as unknown[]) ?? [];
  const vendorRank = (vendorsResult.Item?.['vendorRank'] as Array<{ vendorId: number; vendorName: string; totalReceivedQty: number; openOrders?: number; totalOrders?: number; rank: number }>) ?? [];
  const orders = (ordersResult.Item?.['orders'] as unknown[]) ?? [];
  const totalOrders = (ordersResult.Item?.['totalOrders'] as number) ?? 0;

  // Sum openOrders from vendorRank — this is the authoritative count computed
  // from the full order history, so it matches what each vendor card shows.
  const openOrderCount = vendorRank.reduce((s, r) => s + (r.openOrders ?? 0), 0);

  return json(200, {
    vendors,
    vendorCount: vendors.length,
    vendorRank,
    orders,
    totalOrders,
    openOrderCount,
    cachedAt: ordersResult.Item?.['cachedAt'] ?? vendorsResult.Item?.['cachedAt'] ?? null,
  });
}

async function handleReporting(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId: OWNER_USER_ID, sk: 'POS#REPORTING#SALES' } })
  );

  if (!result.Item) {
    return json(200, {
      rows: [],
      notReady: true,
      message: 'Reporting data has not been synced yet.',
    });
  }

  const rows = (result.Item['rows'] as Array<Record<string, unknown>>) ?? [];
  const rawBrandRows = (result.Item['brandRows'] as Array<Record<string, unknown>>) ?? [];
  const monthRows = (result.Item['monthRows'] as Array<Record<string, unknown>>) ?? [];
  const returnRows = (result.Item['returnRows'] as Array<Record<string, unknown>>) ?? [];
  const customerRows = (result.Item['customerRows'] as Array<Record<string, unknown>>) ?? [];
  const totalsRows = (result.Item['totalsRows'] as Array<Record<string, unknown>>) ?? [];
  const fromDate = result.Item['fromDate'] as string;
  const toDate = result.Item['toDate'] as string;
  const yearStart = result.Item['yearStart'] as string;

  // Normalize brand names — merge case-insensitive duplicates ("NAOT" + "naot")
  // and label null/empty brands explicitly. Also surface a flag when we merged.
  const brandTotals = new Map<string, { brand: string; netSales: number; netQty: number; netMargin: number; transactions: number; variants: Set<string>; isNullBrand: boolean }>();
  for (const r of rawBrandRows) {
    const rawBrand = (r['item.custom@brand'] as string | undefined)?.trim() ?? '';
    const isNull = rawBrand === '';
    const key = isNull ? '__NULL__' : rawBrand.toUpperCase();
    const displayName = isNull ? '(brand not set)' : rawBrand;
    let entry = brandTotals.get(key);
    if (!entry) {
      entry = { brand: displayName, netSales: 0, netQty: 0, netMargin: 0, transactions: 0, variants: new Set(), isNullBrand: isNull };
      brandTotals.set(key, entry);
    }
    entry.netSales += (r['source_sales.net_sales'] as number) ?? 0;
    entry.netQty += (r['source_sales.net_qty_sold'] as number) ?? 0;
    entry.netMargin += (r['source_sales.net_margin'] as number) ?? 0;
    entry.transactions += (r['source_sales.transaction_count'] as number) ?? 0;
    if (!isNull) entry.variants.add(rawBrand);
    // Prefer the most "title cased" variant as the display name
    if (!isNull && rawBrand.length > 0 && rawBrand[0] === rawBrand[0]?.toUpperCase()) {
      entry.brand = rawBrand;
    }
  }

  const brandRows = Array.from(brandTotals.values()).map((b) => ({
    'item.custom@brand': b.brand,
    'source_sales.net_sales': Math.round(b.netSales * 100) / 100,
    'source_sales.net_qty_sold': b.netQty,
    'source_sales.net_margin': Math.round(b.netMargin * 100) / 100,
    'source_sales.transaction_count': b.transactions,
    variantCount: b.variants.size > 1 ? b.variants.size : undefined,
    variants: b.variants.size > 1 ? Array.from(b.variants) : undefined,
    isNullBrand: b.isNullBrand || undefined,
  }));

  // Daily totals (last 30 days) — for the Reporting tab daily section
  const dailyTotalSales = rows.reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0);
  const dailyTotalTxns = rows.reduce((s, r) => s + ((r['source_sales.transaction_count'] as number) ?? 0), 0);

  // YTD summary — prefer the dedicated totalsRows aggregate (one row per year,
  // grouped by date.year). The totals query intentionally excludes net_margin
  // because Heartland's analyzer 500s on every margin query for this account
  // (probably a token-scope issue). When margin isn't available we leave it
  // null so the UI can show "—" instead of a misleading $0.
  const totalsAgg = totalsRows.length > 0 ? totalsRows : null;
  const brandSumNetSales = Array.from(brandTotals.values()).reduce((s, b) => s + b.netSales, 0);
  const brandSumTxns = Array.from(brandTotals.values()).reduce((s, b) => s + b.transactions, 0);
  const ytdNetSales = totalsAgg
    ? totalsAgg.reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0)
    : brandSumNetSales;
  const ytdTransactions = totalsAgg
    ? totalsAgg.reduce((s, r) => s + ((r['source_sales.transaction_count'] as number) ?? 0), 0)
    : brandSumTxns;
  // Margin: only set if the totals payload actually carries it. Otherwise null.
  let ytdNetMargin: number | null = null;
  if (totalsAgg) {
    const sum = totalsAgg.reduce(
      (s, r) => s + ((r['source_sales.net_margin'] as number) ?? 0),
      0
    );
    ytdNetMargin = sum > 0 ? sum : null;
  }
  const marginAvailable = ytdNetMargin !== null;

  // Compute customer retention: customers with >1 transaction = repeat buyers
  const repeatCustomers = customerRows.filter((r) => ((r['source_sales.transaction_count'] as number) ?? 0) > 1).length;
  const totalCustomers = customerRows.filter((r) => r['customer.public_id']).length;
  const newCustomers = totalCustomers - repeatCustomers;
  const repeatRevenue = customerRows
    .filter((r) => ((r['source_sales.transaction_count'] as number) ?? 0) > 1)
    .reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0);

  return json(200, {
    fromDate,
    toDate,
    yearStart,
    summary: {
      // YTD figures — what the user actually wants to see at the top of the Reporting tab
      totalNetSales: Math.round(ytdNetSales * 100) / 100,
      totalTransactions: ytdTransactions,
      totalNetMargin: ytdNetMargin !== null ? Math.round(ytdNetMargin * 100) / 100 : null,
      avgNetMarginPct:
        ytdNetMargin !== null && ytdNetSales > 0
          ? Math.round((ytdNetMargin / ytdNetSales) * 1000) / 10
          : null,
      marginAvailable,
      // 30-day window totals exposed separately so the daily section isn't misleading
      last30Days: {
        netSales: Math.round(dailyTotalSales * 100) / 100,
        transactions: dailyTotalTxns,
      },
    },
    dailyRows: rows.sort((a, b) =>
      String(a['date.date'] ?? '').localeCompare(String(b['date.date'] ?? ''))
    ),
    monthRows: monthRows.sort((a, b) =>
      String(a['date.month_of_year'] ?? '').localeCompare(String(b['date.month_of_year'] ?? ''))
    ),
    brandRows: brandRows.sort((a, b) =>
      ((b['source_sales.net_sales'] as number) ?? 0) - ((a['source_sales.net_sales'] as number) ?? 0)
    ),
    returnRows: returnRows.sort((a, b) =>
      ((b['source_sales.gross_returns'] as number) ?? 0) - ((a['source_sales.gross_returns'] as number) ?? 0)
    ),
    customerInsights: {
      totalCustomers,
      repeatCustomers,
      newCustomers,
      repeatRate: totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 1000) / 10 : 0,
      repeatRevenue: Math.round(repeatRevenue * 100) / 100,
      repeatRevenuePct: ytdNetSales > 0 ? Math.round((repeatRevenue / ytdNetSales) * 1000) / 10 : 0,
    },
    cachedAt: result.Item['cachedAt'],
  });
}

// ── GET /pos/insights ────────────────────────────────────────────────
//
// Year-aware insights endpoint. The sync Lambda caches per-year reporting
// rollups at POS#REPORTING#YEAR#YYYY for the current year + 3 prior years.
// This handler reads those keys and shapes them like the existing reporting
// response so the frontend Insights tab can render the same visuals filtered
// by year.
//
// Query params:
//   ?year=YYYY  → return that single year's data
//   ?year=all   → return aggregate across all available years
//   omit        → defaults to current year (Central Time)

async function handleInsights(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const today = todayStr();
  const currentYear = parseInt(today.slice(0, 4), 10);
  const yearParam = event.queryStringParameters?.['year'] ?? String(currentYear);

  // Build list of years to look up.
  // The sync caches current + 3 prior years, so we query that window.
  const lookupYears: number[] = [];
  for (let y = currentYear; y >= currentYear - 3; y--) lookupYears.push(y);

  // Fetch all year buckets in parallel
  const yearItems = await Promise.all(
    lookupYears.map((y) =>
      docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { userId: OWNER_USER_ID, sk: `POS#REPORTING#YEAR#${y}` },
        })
      ).then((r) => ({ year: y, item: r.Item }))
    )
  );

  const availableYears = yearItems.filter((r) => r.item).map((r) => r.year);

  if (availableYears.length === 0) {
    return json(200, {
      notReady: true,
      message: 'Year-aware insights have not been synced yet.',
      availableYears: [],
    });
  }

  // Pick which years to include based on the param
  let selectedYears: number[];
  let scopeLabel: string;
  if (yearParam === 'all') {
    selectedYears = availableYears;
    scopeLabel = `All available (${availableYears.join(', ')})`;
  } else {
    const wanted = parseInt(yearParam, 10);
    if (!Number.isFinite(wanted) || !availableYears.includes(wanted)) {
      // Fall back to the most recent available year if the requested one
      // isn't synced yet.
      selectedYears = [availableYears[0]!];
      scopeLabel = `${selectedYears[0]} (requested ${yearParam} not available)`;
    } else {
      selectedYears = [wanted];
      scopeLabel = String(wanted);
    }
  }

  // Aggregate brand / return / customer rows across selected years
  type NumRecord = Record<string, unknown>;
  const brandTotals = new Map<string, { brand: string; netSales: number; netQty: number; netMargin: number; transactions: number; variants: Set<string>; isNullBrand: boolean }>();
  const returnAccum = new Map<string, { brand: string; grossSales: number; grossReturns: number; grossQtySold: number; grossQtyReturned: number }>();
  const customerAccum = new Map<string, { publicId: string; netSales: number; transactions: number }>();
  // Year-aggregate totals (net_margin lives here; brand grouping can't have it
  // because Heartland's analyzer 500s on that combination)
  let aggregateNetSales = 0;
  let aggregateNetMargin = 0;
  let aggregateTransactions = 0;
  let earliestFrom = '';
  let latestTo = '';
  let cachedAt: string | null = null;

  for (const r of yearItems) {
    if (!r.item || !selectedYears.includes(r.year)) continue;
    const item = r.item;
    if (!earliestFrom || (item['fromDate'] && (item['fromDate'] as string) < earliestFrom)) {
      earliestFrom = item['fromDate'] as string;
    }
    if (!latestTo || (item['toDate'] && (item['toDate'] as string) > latestTo)) {
      latestTo = item['toDate'] as string;
    }
    const ca = item['cachedAt'] as string | undefined;
    if (ca && (!cachedAt || ca > cachedAt)) cachedAt = ca;

    const totalsRows = (item['totalsRows'] as NumRecord[] | undefined) ?? [];
    for (const tr of totalsRows) {
      aggregateNetSales += (tr['source_sales.net_sales'] as number) ?? 0;
      aggregateNetMargin += (tr['source_sales.net_margin'] as number) ?? 0;
      aggregateTransactions += (tr['source_sales.transaction_count'] as number) ?? 0;
    }

    const brandRows = (item['brandRows'] as NumRecord[] | undefined) ?? [];
    for (const br of brandRows) {
      const rawBrand = ((br['item.custom@brand'] as string | undefined) ?? '').trim();
      const isNull = rawBrand === '';
      const key = isNull ? '__NULL__' : rawBrand.toUpperCase();
      const displayName = isNull ? '(brand not set)' : rawBrand;
      let entry = brandTotals.get(key);
      if (!entry) {
        entry = { brand: displayName, netSales: 0, netQty: 0, netMargin: 0, transactions: 0, variants: new Set(), isNullBrand: isNull };
        brandTotals.set(key, entry);
      }
      entry.netSales += (br['source_sales.net_sales'] as number) ?? 0;
      entry.netQty += (br['source_sales.net_qty_sold'] as number) ?? 0;
      entry.netMargin += (br['source_sales.net_margin'] as number) ?? 0;
      entry.transactions += (br['source_sales.transaction_count'] as number) ?? 0;
      if (!isNull) entry.variants.add(rawBrand);
      if (!isNull && rawBrand.length > 0 && rawBrand[0] === rawBrand[0]?.toUpperCase()) {
        entry.brand = rawBrand;
      }
    }

    const returnRows = (item['returnRows'] as NumRecord[] | undefined) ?? [];
    for (const rr of returnRows) {
      const rawBrand = ((rr['item.custom@brand'] as string | undefined) ?? '').trim();
      const key = rawBrand === '' ? '__NULL__' : rawBrand.toUpperCase();
      let entry = returnAccum.get(key);
      if (!entry) {
        entry = { brand: rawBrand || '(brand not set)', grossSales: 0, grossReturns: 0, grossQtySold: 0, grossQtyReturned: 0 };
        returnAccum.set(key, entry);
      }
      entry.grossSales += (rr['source_sales.gross_sales'] as number) ?? 0;
      entry.grossReturns += (rr['source_sales.gross_returns'] as number) ?? 0;
      entry.grossQtySold += (rr['source_sales.gross_qty_sold'] as number) ?? 0;
      entry.grossQtyReturned += (rr['source_sales.gross_qty_returned'] as number) ?? 0;
    }

    const customerRows = (item['customerRows'] as NumRecord[] | undefined) ?? [];
    for (const cr of customerRows) {
      const pid = (cr['customer.public_id'] as string | undefined) ?? '';
      if (!pid) continue;
      let entry = customerAccum.get(pid);
      if (!entry) {
        entry = { publicId: pid, netSales: 0, transactions: 0 };
        customerAccum.set(pid, entry);
      }
      entry.netSales += (cr['source_sales.net_sales'] as number) ?? 0;
      entry.transactions += (cr['source_sales.transaction_count'] as number) ?? 0;
    }
  }

  const brandRows = Array.from(brandTotals.values())
    .map((b) => ({
      'item.custom@brand': b.brand,
      'source_sales.net_sales': Math.round(b.netSales * 100) / 100,
      'source_sales.net_qty_sold': b.netQty,
      'source_sales.net_margin': Math.round(b.netMargin * 100) / 100,
      'source_sales.transaction_count': b.transactions,
      variantCount: b.variants.size > 1 ? b.variants.size : undefined,
      variants: b.variants.size > 1 ? Array.from(b.variants) : undefined,
      isNullBrand: b.isNullBrand || undefined,
    }))
    .sort((a, b) => (b['source_sales.net_sales'] ?? 0) - (a['source_sales.net_sales'] ?? 0));

  const returnRows = Array.from(returnAccum.values())
    .map((r) => ({
      'item.custom@brand': r.brand,
      'source_sales.gross_sales': Math.round(r.grossSales * 100) / 100,
      'source_sales.gross_returns': Math.round(r.grossReturns * 100) / 100,
      'source_sales.gross_qty_sold': r.grossQtySold,
      'source_sales.gross_qty_returned': r.grossQtyReturned,
    }))
    .sort((a, b) => (b['source_sales.gross_returns'] ?? 0) - (a['source_sales.gross_returns'] ?? 0));

  const repeatBuyers = Array.from(customerAccum.values()).filter((c) => c.transactions > 1);
  const totalCustomers = customerAccum.size;
  const repeatCustomers = repeatBuyers.length;
  const newCustomers = totalCustomers - repeatCustomers;
  const repeatRevenue = repeatBuyers.reduce((s, c) => s + c.netSales, 0);
  // Prefer the totals aggregate; fall back to brand sums for sales+transactions.
  // Margin is null when Heartland didn't return it (token doesn't expose it).
  const brandSumNetSales = Array.from(brandTotals.values()).reduce((s, b) => s + b.netSales, 0);
  const totalNetSales = aggregateNetSales > 0 ? aggregateNetSales : brandSumNetSales;
  const totalTransactions =
    aggregateTransactions > 0
      ? aggregateTransactions
      : Array.from(brandTotals.values()).reduce((s, b) => s + b.transactions, 0);
  const totalNetMargin = aggregateNetMargin > 0 ? aggregateNetMargin : null;

  return json(200, {
    scope: scopeLabel,
    selectedYears,
    availableYears,
    fromDate: earliestFrom,
    toDate: latestTo,
    summary: {
      totalNetSales: Math.round(totalNetSales * 100) / 100,
      totalTransactions,
      totalNetMargin: totalNetMargin !== null ? Math.round(totalNetMargin * 100) / 100 : null,
      marginAvailable: totalNetMargin !== null,
    },
    brandRows,
    returnRows,
    customerInsights: {
      totalCustomers,
      repeatCustomers,
      newCustomers,
      repeatRate: totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 1000) / 10 : 0,
      repeatRevenue: Math.round(repeatRevenue * 100) / 100,
      repeatRevenuePct: totalNetSales > 0 ? Math.round((repeatRevenue / totalNetSales) * 1000) / 10 : 0,
    },
    cachedAt,
  });
}

// ── GET /pos/purchasing/orders/{id}/lines ────────────────────────────
//
// Returns the line items for a single PO. Called on-demand when the user
// expands a PO row in the open-orders modal. Hits Heartland directly since
// caching every PO's lines would be wasteful (most are never viewed).
async function handlePurchaseOrderLines(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const orderId = event.pathParameters?.['id'];
  if (!orderId || !/^\d+$/.test(orderId)) {
    return json(400, { error: 'Order id is required and must be numeric' });
  }

  try {
    const data = await fetchFromHeartland<{
      results: Array<{
        id: number;
        item_id: number;
        qty: number;
        qty_received?: number;
        qty_expected?: number;
        unit_cost: number;
        extended_cost?: number;
        original_cost?: number;
        status?: string;
        name?: string;
        line_display_id?: string;
        item_custom?: { brand?: string; size?: string; color?: string; width?: string; department?: string; style_number?: string };
      }>;
      total: number;
    }>(`purchasing/orders/${orderId}/lines`);

    // Slim the payload — strip the giant items_added_by_autogridding arrays
    const lines = (data.results ?? []).map((l) => ({
      id: l.id,
      item_id: l.item_id,
      qty: l.qty,
      qty_received: l.qty_received ?? 0,
      qty_open: Math.max(0, (l.qty ?? 0) - (l.qty_received ?? 0)),
      unit_cost: l.unit_cost,
      extended_cost: l.extended_cost,
      original_cost: l.original_cost,
      status: l.status,
      name: l.name,
      sku: l.line_display_id,
      brand: l.item_custom?.brand,
      size: l.item_custom?.size,
      color: l.item_custom?.color,
      width: l.item_custom?.width,
      department: l.item_custom?.department,
      style_number: l.item_custom?.style_number,
    }));

    return json(200, {
      orderId: parseInt(orderId, 10),
      lineCount: data.total ?? lines.length,
      lines,
    });
  } catch (err) {
    console.error('Failed to fetch order lines:', (err as Error).message);
    return json(502, { error: 'Failed to fetch order lines from Heartland' });
  }
}

// ── Vendor settings (account flags + card overrides + custom contacts) ──
//
// Stored in DynamoDB under the owner's partition so the data survives
// redeployments and is consistent across all browsers/devices.
//
// DynamoDB item shape:
//   { userId: OWNER_USER_ID, sk: 'POS#VENDOR#SETTINGS',
//     activeAccounts: string[],          // e.g. ["vendor-account:123"]
//     discontinuedVendors: string[],     // e.g. ["vendor-account:456"]
//     vendorOverrides: Record<string, VendorOverride>,
//     customContacts: Record<string, VendorContact[]>,
//     updatedAt: string }

async function handleGetVendorSettings(): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#VENDOR#SETTINGS' },
    })
  );
  if (!result.Item) {
    return json(200, {
      activeAccounts: [],
      discontinuedVendors: [],
      contactedVendors: [],
      vendorOverrides: {},
      customContacts: {},
      updatedAt: null,
    });
  }
  return json(200, {
    activeAccounts: result.Item['activeAccounts'] ?? [],
    discontinuedVendors: result.Item['discontinuedVendors'] ?? [],
    contactedVendors: result.Item['contactedVendors'] ?? [],
    vendorOverrides: result.Item['vendorOverrides'] ?? {},
    customContacts: result.Item['customContacts'] ?? {},
    updatedAt: result.Item['updatedAt'] ?? null,
  });
}

async function handlePutVendorSettings(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  let body: {
    activeAccounts?: string[];
    discontinuedVendors?: string[];
    contactedVendors?: string[];
    vendorOverrides?: Record<string, unknown>;
    customContacts?: Record<string, unknown[]>;
  };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  // Basic validation — all fields are optional (partial updates allowed)
  if (body.activeAccounts !== undefined && !Array.isArray(body.activeAccounts)) {
    return json(400, { error: 'activeAccounts must be an array' });
  }
  if (body.discontinuedVendors !== undefined && !Array.isArray(body.discontinuedVendors)) {
    return json(400, { error: 'discontinuedVendors must be an array' });
  }
  if (body.contactedVendors !== undefined && !Array.isArray(body.contactedVendors)) {
    return json(400, { error: 'contactedVendors must be an array' });
  }

  // Read existing item so we can merge (partial update semantics)
  const existing = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#VENDOR#SETTINGS' },
    })
  );
  const prev = existing.Item ?? {};

  const updatedAt = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'POS#VENDOR#SETTINGS',
        activeAccounts: body.activeAccounts ?? prev['activeAccounts'] ?? [],
        discontinuedVendors: body.discontinuedVendors ?? prev['discontinuedVendors'] ?? [],
        contactedVendors: body.contactedVendors ?? prev['contactedVendors'] ?? [],
        vendorOverrides: body.vendorOverrides ?? prev['vendorOverrides'] ?? {},
        customContacts: body.customContacts ?? prev['customContacts'] ?? {},
        updatedAt,
      },
    })
  );

  return json(200, { ok: true, updatedAt });
}

async function handleSyncStatus(): Promise<APIGatewayProxyResultV2> {
  const status = await getSyncStatus();
  if (!status) {
    return json(200, {
      lastSyncAt: null,
      status: 'never',
      message: 'No sync has run yet. The first scheduled sync runs every 6 hours, or trigger one manually.',
    });
  }
  return json(200, status);
}

async function handleTriggerSync(): Promise<APIGatewayProxyResultV2> {
  if (!SYNC_FUNCTION_NAME) {
    return json(500, { error: 'Sync function not configured' });
  }
  try {
    // Invoke async — returns immediately, sync runs in background
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SYNC_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })),
      })
    );
    return json(202, {
      status: 'queued',
      message: 'Sync started. Check /pos/sync-status in 30-60 seconds for results.',
    });
  } catch (err) {
    console.error('Failed to invoke sync:', (err as Error).message);
    return json(500, { error: 'Failed to start sync' });
  }
}

// ── Main Handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  switch (event.routeKey) {
    case 'GET /pos/dashboard':
      return handleDashboard(event);
    case 'GET /pos/sales':
      return handleSalesByYear(event);
    case 'GET /pos/import-tax-defaults':
      return handleImportTaxDefaults(event);
    case 'GET /pos/analytics':
      return handleAnalytics(event);
    case 'GET /pos/inventory':
      return handleInventory();
    case 'GET /pos/staff':
      return handleStaff(event);
    case 'GET /pos/purchasing':
      return handlePurchasing();
    case 'GET /pos/purchasing/orders/{id}/lines':
      return handlePurchaseOrderLines(event);
    case 'GET /pos/reporting':
      return handleReporting(event);
    case 'GET /pos/insights':
      return handleInsights(event);
    case 'GET /pos/sync-status':
      return handleSyncStatus();
    case 'POST /pos/sync':
      return handleTriggerSync();
    case 'GET /pos/vendor-settings':
      return handleGetVendorSettings();
    case 'PUT /pos/vendor-settings':
      return handlePutVendorSettings(event);
    default:
      return json(404, { error: 'Route not found' });
  }
};
