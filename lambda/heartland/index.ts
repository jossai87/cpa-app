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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import { v4 as uuidv4 } from 'uuid';
import { cacheVendorActivity, cacheStats } from '../gmail-analysis/cache';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({ region: 'us-east-1' });
const sesClient = new SESv2Client({ region: 'us-east-1' });
// Cost Explorer is only available in us-east-1
const ceClient = new CostExplorerClient({ region: 'us-east-1' });

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
  /** Tax collected per rep — written by sync. May be missing on legacy
      rollup rows (treat as zero in that case). */
  taxBySalesRep?: Record<string, number>;
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
      // 'ok' | 'partial' | 'error' | 'never' — used by the UI's
      // "Synced N min ago" badge to show a yellow warning when the
      // most recent sync hit upstream errors (e.g. Heartland 500
      // for payments) so the cards aren't shown as fresh.
      status: status?.['status'] ?? 'never',
      // Per-section error messages so the UI / agent can surface the
      // exact upstream issue (e.g. "Heartland payments API: 500
      // internal_error") instead of silently showing stale data.
      sectionErrors: extractSectionErrors(status),
    },
    asOf: new Date().toISOString(),
  });
}

/**
 * Pluck `{section: errorMessage}` pairs out of the sync-status row.
 * Each section in the sync handler writes either a success result
 * object or `{error: string}` — we surface only the errors.
 */
function extractSectionErrors(
  status: Record<string, unknown> | null | undefined
): Record<string, string> {
  if (!status || typeof status !== 'object') return {};
  const out: Record<string, string> = {};
  const sectionNames = ['payments', 'inventory', 'purchasing', 'reporting', 'staff'];
  for (const name of sectionNames) {
    const s = status[name];
    if (s && typeof s === 'object' && 'error' in s) {
      const err = (s as { error?: unknown }).error;
      if (typeof err === 'string') out[name] = err;
    }
  }
  return out;
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

  const repTotals: Record<string, { amount: number; tax: number; days: number }> = {};
  for (const r of rollups) {
    for (const [rep, amt] of Object.entries(r.bySalesRep ?? {})) {
      if (!repTotals[rep]) repTotals[rep] = { amount: 0, tax: 0, days: 0 };
      repTotals[rep]!.amount += amt;
      repTotals[rep]!.tax += (r.taxBySalesRep?.[rep] ?? 0);
      repTotals[rep]!.days += 1;
    }
  }

  const staff = Object.entries(repTotals)
    .map(([rep, v]) => {
      const taxRounded = Math.round(v.tax * 100) / 100;
      const amountRounded = Math.round(v.amount * 100) / 100;
      const amountExTax = Math.round((v.amount - v.tax) * 100) / 100;
      return {
        name: userMap[rep] ?? rep,
        rawName: rep,
        // amount = net of tax (the headline number). Kept for backward compat
        // — older clients may still read this field.
        amount: amountExTax,
        amountInclTax: amountRounded,
        taxAmount: taxRounded,
        activeDays: v.days,
        avgPerDay: v.days > 0 ? Math.round((amountExTax / v.days) * 100) / 100 : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const status = await getSyncStatus();

  // Becky's orthotic count for the period — used for her per-orthotic
  // bonus on the Staff page. We query the analyzer directly so the
  // count matches the date window the user selected. Heartland uses
  // user.full_name for sales-rep grouping. We filter on the orthotic
  // department keyword(s).
  let beckyOrthoticCount: number | null = null;
  try {
    interface AnalyzerResponse {
      results: Array<Record<string, unknown>>;
    }
    const analyzerPath =
      `reporting/analyzer?metrics[]=source_sales.net_qty_sold` +
      `&groups[]=user.full_name` +
      `&groups[]=item.custom@department` +
      `&start_date=${fromDate}&end_date=${toDate}`;
    const data = await fetchFromHeartland<AnalyzerResponse>(analyzerPath);
    let total = 0;
    for (const row of data.results ?? []) {
      const name = String(row['user.full_name'] ?? '').toLowerCase();
      const dept = String(row['item.custom@department'] ?? '').toLowerCase();
      const qty = Number(row['source_sales.net_qty_sold'] ?? 0);
      if (!name.includes('becky')) continue;
      if (!dept.includes('orthotic')) continue;
      if (qty > 0) total += qty;
    }
    beckyOrthoticCount = Math.round(total);
  } catch (err) {
    // Don't fail the whole staff response if the analyzer hiccups —
    // the bonus card just won't get a count this time.
    console.warn('beckyOrthoticCount fetch failed:', (err as Error).message);
    beckyOrthoticCount = null;
  }

  return json(200, {
    period,
    label,
    fromDate,
    toDate,
    staff,
    totalUsers: users.length,
    beckyOrthoticCount,
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

// ── GET /pos/vendor-health ───────────────────────────────────────────
//
// Joins POS brand performance (net sales YTD) with the local Gmail cache
// (last 90 days of vendor email activity). One lightweight call powering
// the Vendor Health row on the Sales & Revenue page.
async function handleVendorHealth(): Promise<APIGatewayProxyResultV2> {
  const reporting = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#REPORTING#SALES' },
    })
  );

  type Row = Record<string, unknown>;
  const brandRows = (reporting.Item?.['brandRows'] as Row[] | undefined) ?? [];

  // Merge case-insensitively, top 10 by net sales
  const merged = new Map<string, { brand: string; netSales: number; units: number }>();
  for (const r of brandRows) {
    const raw = ((r['item.custom@brand'] as string | undefined) ?? '').trim();
    if (!raw) continue;
    const key = raw.toUpperCase();
    let entry = merged.get(key);
    if (!entry) {
      entry = { brand: raw, netSales: 0, units: 0 };
      merged.set(key, entry);
    }
    entry.netSales += (r['source_sales.net_sales'] as number) ?? 0;
    entry.units += (r['source_sales.net_qty_sold'] as number) ?? 0;
  }
  const topBrands = [...merged.values()]
    .map((b) => ({
      brand: b.brand,
      netSalesYTD: Math.round(b.netSales * 100) / 100,
      unitsYTD: b.units,
    }))
    .sort((a, b) => b.netSalesYTD - a.netSalesYTD)
    .slice(0, 10);

  // Pull email activity for each in parallel — cache.ts queries DDB only
  const cache = await cacheStats();
  const cacheReady = cache.totalCanonical > 0;

  const enriched = await Promise.all(
    topBrands.map(async (b) => {
      let activity: Awaited<ReturnType<typeof cacheVendorActivity>> | null = null;
      if (cacheReady) {
        try {
          activity = await cacheVendorActivity(b.brand, 90);
        } catch {
          /* swallow — vendor row should still render */
        }
      }
      return {
        ...b,
        emailActivity: activity
          ? {
              messageCount: activity.messageCount,
              lastContactDate: activity.lastContactDate,
              topSenders: activity.topSenders.slice(0, 3),
              topSubjects: activity.topSubjects.slice(0, 3),
              recentMessageIds: activity.recentMessageIds.slice(0, 5),
            }
          : null,
      };
    })
  );

  return json(200, {
    asOf: new Date().toISOString(),
    cacheReady,
    cacheCoverage: cacheReady
      ? {
          totalMessages: cache.totalCanonical,
          oldestDate: cache.oldestDate,
          newestDate: cache.newestDate,
        }
      : null,
    brands: enriched,
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
      contactNotes: {},
      vendorComments: {},
      vendorOverrides: {},
      customContacts: {},
      customVendors: [],
      updatedAt: null,
    });
  }
  return json(200, {
    activeAccounts: result.Item['activeAccounts'] ?? [],
    discontinuedVendors: result.Item['discontinuedVendors'] ?? [],
    contactedVendors: result.Item['contactedVendors'] ?? [],
    contactNotes: result.Item['contactNotes'] ?? {},
    vendorComments: result.Item['vendorComments'] ?? {},
    vendorOverrides: result.Item['vendorOverrides'] ?? {},
    customContacts: result.Item['customContacts'] ?? {},
    customVendors: result.Item['customVendors'] ?? [],
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
    contactNotes?: Record<string, string>;
    vendorComments?: Record<string, Array<{ id: string; text: string; createdAt: string }>>;
    vendorOverrides?: Record<string, unknown>;
    customContacts?: Record<string, unknown[]>;
    customVendors?: Array<{ id: string; name: string }>;
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
        contactNotes: body.contactNotes ?? prev['contactNotes'] ?? {},
        vendorComments: body.vendorComments ?? prev['vendorComments'] ?? {},
        vendorOverrides: body.vendorOverrides ?? prev['vendorOverrides'] ?? {},
        customContacts: body.customContacts ?? prev['customContacts'] ?? {},
        customVendors: body.customVendors ?? prev['customVendors'] ?? [],
        updatedAt,
      },
    })
  );

  return json(200, { ok: true, updatedAt });
}

// ── Admin settings (visibility overrides for non-admin users) ─────────
//
// Stored under the owner's partition. Writes are restricted to the admin
// email — non-admin users can read but not modify.

// Source of truth lives in the CDK stack (`ADMIN_EMAIL` constant in
// `infrastructure/lib/foot-solutions-stack.ts`) and is injected via the
// Lambda environment. The hard-coded fallback is only here so a cold
// start during the initial CDK deploy (before the env var lands) still
// resolves to the correct value.
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'jandoossai@gmail.com';
const ADMIN_SUB = 'f4682498-d0d1-70cd-c302-27ff64bb2b6e';

function getCallerEmail(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  return ((event.requestContext.authorizer.jwt.claims['email'] as string | undefined) ?? '').toLowerCase();
}

function getCallerSub(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  return ((event.requestContext.authorizer.jwt.claims['sub'] as string | undefined) ?? '');
}

/**
 * Admin gate. The frontend sends the Cognito ACCESS token in the
 * Authorization header — access tokens carry `sub` + `username` but NOT
 * `email`. So we accept either:
 *   • email claim equals ADMIN_EMAIL (present on ID tokens), OR
 *   • sub claim equals ADMIN_SUB (the admin user's Cognito sub —
 *     present on BOTH access and ID tokens).
 *
 * Note: ADMIN_SUB is intentionally distinct from OWNER_USER_ID. The owner
 * data partition (94989478-…) is a legacy seed; the live admin's Cognito
 * sub is what actually shows up in API GW JWT claims.
 */
function isAdminCaller(event: APIGatewayProxyEventV2WithJWTAuthorizer): boolean {
  const email = getCallerEmail(event);
  if (email && email === ADMIN_EMAIL.toLowerCase()) return true;
  const sub = getCallerSub(event);
  if (sub && sub === ADMIN_SUB) return true;
  return false;
}

async function handleGetAdminSettings(): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'ADMIN#SETTINGS' },
    })
  );
  return json(200, {
    visibilityOverrides: result.Item?.['visibilityOverrides'] ?? {},
    dailyTarget: result.Item?.['dailyTarget'] ?? 1500,
    updatedAt: result.Item?.['updatedAt'] ?? null,
  });
}

async function handlePutAdminSettings(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Only the admin can modify admin settings' });
  }
  // Capture caller identity for the audit field — prefer email when
  // present (ID token), fall back to sub (access token).
  const updatedBy = getCallerEmail(event) || getCallerSub(event) || 'admin';

  let body: { visibilityOverrides?: Record<string, boolean>; dailyTarget?: number };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (body.visibilityOverrides && typeof body.visibilityOverrides !== 'object') {
    return json(400, { error: 'visibilityOverrides must be an object' });
  }
  if (body.dailyTarget !== undefined && (typeof body.dailyTarget !== 'number' || body.dailyTarget < 0)) {
    return json(400, { error: 'dailyTarget must be a positive number' });
  }

  // Read existing to merge fields not in the patch
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { userId: OWNER_USER_ID, sk: 'ADMIN#SETTINGS' },
  }));
  const prev = existing.Item ?? {};

  const updatedAt = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: 'ADMIN#SETTINGS',
        visibilityOverrides: body.visibilityOverrides ?? prev['visibilityOverrides'] ?? {},
        dailyTarget: body.dailyTarget ?? prev['dailyTarget'] ?? 1500,
        updatedAt,
        updatedBy,
      },
    })
  );

  return json(200, { ok: true, updatedAt });
}

// ── Email history (for the dashboard right-side feed) ────────────────

async function handleGetEmails(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const limit = Math.min(60, parseInt(event.queryStringParameters?.['limit'] ?? '30', 10));
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':uid': OWNER_USER_ID, ':prefix': 'EMAIL#' },
      ScanIndexForward: false, // newest first
      Limit: limit,
    })
  );
  const emails = (result.Items ?? []).map((item) => ({
    date: item['date'],
    subject: item['subject'],
    bodyText: item['bodyText'],
    bodyHtml: item['bodyHtml'],
    status: item['status'],
    sendStatus: item['sendStatus'],
    sendError: item['sendError'] ?? null,
    generatedAt: item['generatedAt'],
  }));
  return json(200, { emails });
}

// Trigger a test send (admin only) — invokes the daily-report Lambda async
async function handleTestEmail(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Only the admin can trigger test emails' });
  }
  const fnName = process.env['DAILY_REPORT_FUNCTION_NAME'];
  if (!fnName) return json(500, { error: 'Daily report function not configured' });

  await lambdaClient.send(new InvokeCommand({
    FunctionName: fnName,
    InvocationType: 'Event', // async
    Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })),
  }));
  return json(202, { ok: true, message: 'Email generation queued — check the feed in 30-60 seconds.' });
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

// ── Vendor comment reply notification ─────────────────────────────────
//
// POSTed by the frontend whenever the owner replies to a vendor card comment.
// Sends an email to flowermound@footsolutions.com summarizing the thread.

const REPLY_FROM_ADDRESS =
  process.env['FROM_ADDRESS'] ?? 'notifications@fsmanagementsystem.com';
const REPLY_TO_ADDRESS =
  process.env['VENDOR_REPLY_TO_ADDRESS'] ?? 'flowermound@footsolutions.com';

async function handleVendorCommentReplyNotify(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  let body: {
    vendorName?: string;
    storeName?: string;
    authorEmail?: string;
    originalComment?: { text: string; createdAt?: string };
    reply?: { text: string; createdAt?: string };
  };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (!body.vendorName || !body.originalComment?.text || !body.reply?.text) {
    return json(400, {
      error: 'vendorName, originalComment.text, and reply.text are required',
    });
  }

  const storeName = body.storeName?.trim() || 'Foot Solutions Flower Mound';
  const vendorName = body.vendorName.trim();
  const original = body.originalComment;
  const reply = body.reply;
  const jwtEmail = String(
    event.requestContext.authorizer.jwt.claims['email'] ?? ''
  );
  const author =
    body.authorEmail?.trim() ||
    jwtEmail ||
    'unknown';

  const html = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px;color:#1e293b">💬 New Vendor Comment Reply</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 20px">From the Foot Solutions Management System</p>

    <table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="padding:4px 0;font-weight:600;width:90px">Store:</td><td>${storeName}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Vendor:</td><td><strong style="color:#1e293b">${vendorName}</strong></td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Replied by:</td><td>${escapeHtml(author)}</td></tr>
    </table>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin-bottom:12px">
      <p style="margin:0 0 6px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Original comment</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap">${escapeHtml(original.text)}</p>
      ${original.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#94a3b8">${escapeHtml(original.createdAt)} CT</p>` : ''}
    </div>

    <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:6px;padding:14px;border-left:4px solid #2563eb">
      <p style="margin:0 0 6px;font-size:11px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">↳ Reply</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap;color:#1e293b">${escapeHtml(reply.text)}</p>
      ${reply.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#1e40af">${escapeHtml(reply.createdAt)} CT</p>` : ''}
    </div>

    <p style="font-size:11px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px">
      This notification is sent automatically when anyone replies to a vendor card comment.
    </p>
  </div></body></html>`;

  const text = [
    `New Vendor Comment Reply`,
    ``,
    `Store: ${storeName}`,
    `Vendor: ${vendorName}`,
    `Replied by: ${author}`,
    ``,
    `Original comment:`,
    original.text,
    original.createdAt ? `(${original.createdAt} CT)` : '',
    ``,
    `↳ Reply:`,
    reply.text,
    reply.createdAt ? `(${reply.createdAt} CT)` : '',
  ].filter(Boolean).join('\n');

  try {
    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: `Foot Solutions <${REPLY_FROM_ADDRESS}>`,
      Destination: { ToAddresses: [REPLY_TO_ADDRESS] },
      Content: { Simple: {
        Subject: { Data: `💬 ${vendorName} — comment reply by ${author} (${storeName})` },
        Body: { Html: { Data: html }, Text: { Data: text } },
      }},
    }));
    return json(200, { ok: true });
  } catch (err) {
    console.error('Reply notify SES send failed:', (err as Error).message);
    return json(500, { error: `Failed to send notification: ${(err as Error).message}` });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── New vendor comment notification ───────────────────────────────────
//
// POSTed by the frontend when the owner adds a top-level comment to a
// vendor card. Mirrors the reply-notify flow so every touchpoint on a
// vendor produces an audit-trail email.
async function handleVendorCommentAddNotify(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  let body: {
    vendorName?: string;
    storeName?: string;
    authorEmail?: string;
    comment?: { text: string; createdAt?: string };
  };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  if (!body.vendorName || !body.comment?.text) {
    return json(400, {
      error: 'vendorName and comment.text are required',
    });
  }

  const storeName = body.storeName?.trim() || 'Foot Solutions Flower Mound';
  const vendorName = body.vendorName.trim();
  const comment = body.comment;
  // Prefer the explicit authorEmail from the client; fall back to the
  // JWT-claim email so we always identify the author.
  const jwtEmail = String(
    event.requestContext.authorizer.jwt.claims['email'] ?? ''
  );
  const author =
    body.authorEmail?.trim() ||
    jwtEmail ||
    'unknown';

  const html = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px;color:#1e293b">📝 New Vendor Card Comment</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 20px">From the Foot Solutions Management System</p>

    <table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="padding:4px 0;font-weight:600;width:90px">Store:</td><td>${storeName}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Vendor:</td><td><strong style="color:#1e293b">${escapeHtml(vendorName)}</strong></td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Added by:</td><td>${escapeHtml(author)}</td></tr>
    </table>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;border-left:4px solid #2563eb">
      <p style="margin:0 0 6px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Comment</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap">${escapeHtml(comment.text)}</p>
      ${comment.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#94a3b8">${escapeHtml(comment.createdAt)} CT</p>` : ''}
    </div>

    <p style="font-size:11px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px">
      This notification is sent automatically when anyone adds a comment to a vendor card.
    </p>
  </div></body></html>`;

  const text = [
    `New Vendor Card Comment`,
    ``,
    `Store: ${storeName}`,
    `Vendor: ${vendorName}`,
    `Added by: ${author}`,
    ``,
    `Comment:`,
    comment.text,
    comment.createdAt ? `(${comment.createdAt} CT)` : '',
  ].filter(Boolean).join('\n');

  try {
    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: `Foot Solutions <${REPLY_FROM_ADDRESS}>`,
      Destination: { ToAddresses: [REPLY_TO_ADDRESS] },
      Content: { Simple: {
        Subject: { Data: `📝 ${vendorName} — new comment by ${author} (${storeName})` },
        Body: { Html: { Data: html }, Text: { Data: text } },
      }},
    }));
    return json(200, { ok: true });
  } catch (err) {
    console.error('Comment-add notify SES send failed:', (err as Error).message);
    return json(500, { error: `Failed to send notification: ${(err as Error).message}` });
  }
}

// ── Campaign / customer database (admin-only) ─────────────────────────
//
// Backed by the POS#CUSTOMER#<id> rows the heartland-sync Lambda writes
// from Heartland's /customers endpoint. Three endpoints:
//
//   GET  /pos/customers              — query / filter / stats
//   POST /pos/customers/sync         — trigger a refresh from Heartland
//   POST /campaign/send              — send an HTML campaign via SES
//   GET  /campaign/unsubscribe       — public, sets unsubscribed=true
//
// Email reach is determined by:
//   • email (non-empty)
//   • promotionalEmails === true   (Heartland's "promotional_emails?" flag)
//   • unsubscribed === false       (our app-level unsubscribe state)

import * as crypto from 'crypto';

interface CustomerRow {
  customerId: number;
  publicId?: string | null;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phoneNumber?: string | null;
  active?: boolean;
  promotionalEmails?: boolean;
  promotionalMessages?: boolean;
  loyaltyBalance?: number;
  loyaltyTotal?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  signupMonth?: string | null;
  unsubscribed?: boolean;
  lastPurchaseAt?: string | null;
}

interface CustomerStats {
  totalCustomers: number;
  totalReported: number;
  withEmail: number;
  optedIn: number;
  reachableEmails: number;
  activeCount: number;
  dormant6m: number;
  dormant12m: number;
  dormancyCutoff6m: string | null;
  dormancyCutoff12m: string | null;
  signupsByMonth: Array<{ month: string; count: number }>;
  updatedAt: string | null;
  recencyUpdatedAt: string | null;
}

const HEARTLAND_SYNC_FN_NAME =
  process.env['HEARTLAND_SYNC_FN_NAME'] ?? 'foot-solutions-heartland-sync';

const CAMPAIGN_FROM_ADDRESS =
  process.env['CAMPAIGN_FROM_ADDRESS'] ?? 'notifications@fsmanagementsystem.com';
const CAMPAIGN_REPLY_TO =
  process.env['CAMPAIGN_REPLY_TO'] ?? 'flowermound@footsolutions.com';
const CAMPAIGN_STORE_ADDRESS =
  '2321 Justin Rd, Flower Mound, TX 75028';
const CAMPAIGN_STORE_NAME = 'Foot Solutions Flower Mound';
// Used to sign the unsubscribe token. Doesn't need to rotate — token
// just proves the unsubscribe link came from us. Stable secret is fine
// for this low-stakes use; we're not protecting payments.
const UNSUBSCRIBE_SECRET =
  process.env['UNSUBSCRIBE_SECRET'] ?? 'fs-unsubscribe-2026-do-not-share';

function customerSk(id: number | string): string {
  return `POS#CUSTOMER#${id}`;
}

async function readCustomerStats(): Promise<CustomerStats | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: 'POS#CUSTOMER_STATS' },
    })
  );
  if (!res.Item) return null;
  const item = res.Item as Record<string, unknown>;
  return {
    totalCustomers: Number(item['totalCustomers'] ?? 0),
    totalReported: Number(item['totalReported'] ?? 0),
    withEmail: Number(item['withEmail'] ?? 0),
    optedIn: Number(item['optedIn'] ?? 0),
    reachableEmails: Number(item['reachableEmails'] ?? item['withEmail'] ?? 0),
    activeCount: Number(item['activeCount'] ?? 0),
    dormant6m: Number(item['dormant6m'] ?? 0),
    dormant12m: Number(item['dormant12m'] ?? 0),
    dormancyCutoff6m: (item['dormancyCutoff6m'] as string | null) ?? null,
    dormancyCutoff12m: (item['dormancyCutoff12m'] as string | null) ?? null,
    signupsByMonth: Array.isArray(item['signupsByMonth'])
      ? (item['signupsByMonth'] as Array<{ month: string; count: number }>)
      : [],
    updatedAt: (item['updatedAt'] as string | null) ?? null,
    recencyUpdatedAt: (item['recencyUpdatedAt'] as string | null) ?? null,
  };
}

/**
 * GET /pos/customers
 *
 * Query params (all optional):
 *   q              free-text against name + email
 *   hasEmail       'true' to filter to customers with non-empty email
 *   optedIn        'true' to filter to opted-in (and not unsubscribed)
 *   active         'true' / 'false'
 *   limit          default 100, max 500
 *   cursor         pagination token from previous page
 *
 * Returns: { customers: CustomerRow[], stats: CustomerStats | null,
 *            cursor: string | null, hasMore: boolean }
 */
async function handleGetCustomers(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Customer database is admin-only' });
  }
  const qp = event.queryStringParameters ?? {};
  const q = (qp['q'] ?? '').trim().toLowerCase();
  const hasEmailFilter = qp['hasEmail'] === 'true';
  const optedInFilter = qp['optedIn'] === 'true';
  // 'reachable' filter — same recipient set as a permissive-mode campaign:
  // any email present + not unsubscribed.
  const reachableFilter = qp['reachable'] === 'true';
  // Dormancy filter — '6m' or '12m'. When set, only returns customers
  // whose lastPurchaseAt is older than the cutoff (or missing entirely,
  // which we treat as "very dormant").
  const dormancyFilter = qp['dormancy'] === '6m' ? '6m' : qp['dormancy'] === '12m' ? '12m' : null;
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
  const dormancyCutoff =
    dormancyFilter === '6m' ? cutoff6m : dormancyFilter === '12m' ? cutoff12m : null;
  const activeFilter =
    qp['active'] === 'true'
      ? true
      : qp['active'] === 'false'
        ? false
        : undefined;
  const limit = Math.min(Number(qp['limit'] ?? 100) || 100, 500);
  const cursor = qp['cursor'];

  const collected: CustomerRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf-8')
      );
    } catch {
      /* invalid cursor — start over */
    }
  }
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  // Scan in pages until we collect enough matches OR exhaust the table.
  // A larger DDB page (1MB) typically holds ~3000 customer rows so a few
  // iterations cover even broad queries.
  let scanned = 0;
  const SCAN_LIMIT = 5000;
  while (collected.length < limit && scanned < SCAN_LIMIT) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: {
          ':u': OWNER_USER_ID,
          ':p': 'POS#CUSTOMER#',
        },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of res.Items ?? []) {
      scanned++;
      const c = item as Record<string, unknown>;
      const email = String(c['email'] ?? '').trim();
      if (hasEmailFilter && !email) continue;
      if (reachableFilter) {
        if (!email) continue;
        if (c['unsubscribed'] === true) continue;
      }
      if (optedInFilter) {
        if (!email) continue;
        if (c['promotionalEmails'] !== true) continue;
        if (c['unsubscribed'] === true) continue;
      }
      if (activeFilter !== undefined && c['active'] !== activeFilter) continue;
      if (dormancyCutoff) {
        const lastPurchase = (c['lastPurchaseAt'] as string | undefined)?.slice(0, 10);
        // Treat "no recorded purchase" as fully dormant (matches the
        // stats-row count). If a customer has shopped more recently
        // than the cutoff, drop them from the result.
        if (lastPurchase && lastPurchase >= dormancyCutoff) continue;
      }
      if (q) {
        const hay = `${String(c['nameLower'] ?? '')} ${String(
          c['emailLower'] ?? ''
        )} ${String(c['phoneNumber'] ?? '')}`;
        if (!hay.includes(q)) continue;
      }
      collected.push({
        customerId: Number(c['customerId']),
        publicId: (c['publicId'] as string | null) ?? null,
        firstName: String(c['firstName'] ?? ''),
        lastName: String(c['lastName'] ?? ''),
        name: String(c['name'] ?? ''),
        email,
        phoneNumber: (c['phoneNumber'] as string | null) ?? null,
        active: c['active'] !== false,
        promotionalEmails: c['promotionalEmails'] === true,
        promotionalMessages: c['promotionalMessages'] === true,
        loyaltyBalance: Number(c['loyaltyBalance'] ?? 0),
        loyaltyTotal: Number(c['loyaltyTotal'] ?? 0),
        createdAt: (c['createdAt'] as string | null) ?? null,
        updatedAt: (c['updatedAt'] as string | null) ?? null,
        signupMonth: (c['signupMonth'] as string | null) ?? null,
        unsubscribed: c['unsubscribed'] === true,
        lastPurchaseAt: (c['lastPurchaseAt'] as string | null) ?? null,
      });
      if (collected.length >= limit) break;
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
    if (!lastEvaluatedKey) break;
    exclusiveStartKey = lastEvaluatedKey;
  }

  const nextCursor =
    collected.length >= limit && lastEvaluatedKey
      ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64url')
      : null;

  const stats = await readCustomerStats();
  return json(200, {
    customers: collected,
    stats,
    cursor: nextCursor,
    hasMore: !!nextCursor,
  });
}

/**
 * GET /pos/customers/{id}/history
 *
 * Pulls the customer's recent purchase history directly from Heartland —
 * tickets + line items + resolved item names. Lazy-loaded on demand
 * when admin clicks a customer in the Campaign card. We don't pre-cache
 * this in DDB because it's only needed for the small subset of customers
 * the admin actually opens.
 *
 * Strategy:
 *   1. Query Heartland sales/tickets filtered by customer_id (last 24mo)
 *   2. Take up to 50 most recent completed tickets
 *   3. For each ticket, fetch its lines (sales/tickets/{id}/lines)
 *   4. Resolve unique item_ids → item descriptions in a single batch call
 *   5. Return a clean timeline-friendly payload
 *
 * Response shape:
 *   {
 *     customer: { id, name, email, lastPurchaseAt, totalSpend, ticketCount },
 *     tickets: [
 *       { id, completedAt, total, totalDiscounts, salesRep,
 *         items: [{ description, sku, qty, unitPrice, total }] }
 *     ],
 *     truncated: boolean   // true if more than 50 tickets exist
 *   }
 */
async function handleGetCustomerHistory(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Customer history is admin-only' });
  }

  const customerIdRaw = event.pathParameters?.['id'];
  const customerId = Number(customerIdRaw);
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return json(400, { error: 'Invalid customer id' });
  }

  // ── 1. Look up the canonical customer row from DDB for header info ─
  const ddbItem = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: `POS#CUSTOMER#${customerId}` },
    })
  );
  const customerRow = ddbItem.Item;
  if (!customerRow) {
    return json(404, { error: 'Customer not found in local cache' });
  }

  // ── 2. Fetch tickets from Heartland filtered by customer_id ────────
  // Same windowing approach as the recency sync — Heartland 500's on
  // wide single-window queries. Customers usually have a small number
  // of tickets so we don't need pagination beyond page 1.
  const STORE_TZ = 'America/Chicago';
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmtDate.format(new Date());

  // Walk back in 6-month windows up to 36 months — most customers have
  // <50 tickets so 6 windows × ~10 tickets each is plenty of headroom.
  const windows: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < 6; i++) {
    const end = new Date();
    end.setMonth(end.getMonth() - 6 * i);
    const start = new Date();
    start.setMonth(start.getMonth() - 6 * (i + 1));
    windows.push({
      from: fmtDate.format(start),
      to: i === 0 ? today : fmtDate.format(end),
    });
  }

  type Ticket = {
    id: number;
    total: number;
    total_discounts: number;
    local_completed_at: string | null;
    completed_at: string | null;
    sales_rep: string;
    'completed?': boolean;
    'voided?': boolean;
    customer_id: number;
  };
  const allTickets: Ticket[] = [];
  for (const win of windows) {
    const filter = JSON.stringify({
      customer_id: customerId,
      local_completed_at: {
        $gte: `${win.from}T00:00:00`,
        $lte: `${win.to}T23:59:59`,
      },
    });
    const path = `sales/tickets?_filter=${encodeURIComponent(filter)}`;
    let page = 1;
    while (true) {
      let res;
      try {
        res = await fetchFromHeartland<{
          results: Ticket[];
          total: number;
          pages: number;
        }>(`${path}&page=${page}`);
      } catch (err) {
        console.warn(
          `History: customer ${customerId} window ${win.from}→${win.to} page ${page} failed: ${(err as Error).message}`
        );
        break;
      }
      for (const t of res.results) {
        if (t['voided?']) continue;
        if (!t['completed?']) continue;
        allTickets.push(t);
      }
      if (page >= (res.pages ?? 1)) break;
      page++;
      if (page > 5) break; // sanity cap per window
    }
    if (allTickets.length >= 100) break; // we'll trim to 50 below anyway
  }

  // ── 3. Sort by date desc, take top 50, fetch lines ────────────────
  allTickets.sort((a, b) =>
    (b.local_completed_at ?? '').localeCompare(a.local_completed_at ?? '')
  );
  const truncated = allTickets.length > 50;
  const recentTickets = allTickets.slice(0, 50);

  type Line = {
    id: number;
    type: string;
    item_id: number | null;
    description: string;
    qty: number;
    value: number;
    adjusted_unit_price: number;
    original_unit_price: number;
    public_id?: string | null;
    item_custom?: {
      brand?: string;
      department?: string;
      class?: string;
      color?: string;
      size?: string;
    };
  };
  // Fetch all ticket lines in parallel — Heartland tolerates ~10-20
  // concurrent requests per the existing inventory sync's pattern.
  const linesByTicket = new Map<number, Line[]>();
  const concurrency = 10;
  for (let i = 0; i < recentTickets.length; i += concurrency) {
    const batch = recentTickets.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (t) => {
        try {
          const res = await fetchFromHeartland<{ results: Line[] }>(
            `sales/tickets/${t.id}/lines`
          );
          linesByTicket.set(t.id, res.results ?? []);
        } catch (err) {
          console.warn(
            `History: failed to load lines for ticket ${t.id}: ${(err as Error).message}`
          );
          linesByTicket.set(t.id, []);
        }
      })
    );
  }

  // ── 4. Build response (lines already include description + brand) ─
  // Heartland's sales/tickets/{id}/lines endpoint returns:
  //   • type: 'ItemLine' for actual products (the only line type we keep)
  //   • description: pre-formatted product description
  //   • item_custom.brand / department / class: enrichment fields
  //   • public_id: the SKU/barcode
  // Other line types (taxes, discounts, payments) are skipped because
  // they're already rolled into the ticket totals at the ticket level.

  // ── 5. Build response ─────────────────────────────────────────────
  const tickets = recentTickets.map((t) => {
    const lines = linesByTicket.get(t.id) ?? [];
    // Heartland line `type` values:
    //   ItemLine          — sold product (keep)
    //   ReturnLine        — returned product (keep, marked isReturn)
    //   TaxLine, DiscountLine, PaymentLine, ShippingLine — skip
    const productLines = lines.filter(
      (l) => l.type === 'ItemLine' || l.type === 'ReturnLine'
    );
    return {
      id: t.id,
      completedAt: t.local_completed_at ?? t.completed_at,
      total: t.total,
      totalDiscounts: t.total_discounts,
      salesRep: t.sales_rep || null,
      items: productLines.map((l) => ({
        itemId: l.item_id,
        sku: l.public_id ?? null,
        description: l.description || '(unknown item)',
        brand: l.item_custom?.brand ?? null,
        department: l.item_custom?.department ?? l.item_custom?.class ?? null,
        qty: l.qty,
        unitPrice: l.adjusted_unit_price,
        originalPrice: l.original_unit_price,
        total: l.value,
        isReturn: l.type === 'ReturnLine' || l.qty < 0,
      })),
    };
  });

  // Aggregate spend totals from the (potentially truncated) recent set.
  const totalSpend = tickets.reduce((sum, t) => sum + (t.total ?? 0), 0);
  const ticketCount = tickets.length;

  return json(200, {
    customer: {
      id: customerId,
      name:
        (customerRow['name'] as string) ||
        [customerRow['firstName'], customerRow['lastName']]
          .filter(Boolean)
          .join(' ')
          .trim() ||
        '(no name)',
      email: (customerRow['email'] as string | null) ?? null,
      phoneNumber: (customerRow['phoneNumber'] as string | null) ?? null,
      lastPurchaseAt: (customerRow['lastPurchaseAt'] as string | null) ?? null,
      totalSpend,
      ticketCount,
    },
    tickets,
    truncated,
  });
}

/**
 * POST /pos/customers/sync
 *
 * Fire-and-forget: invokes the heartland-sync Lambda async with
 * trigger='customers-only'. Returns immediately so the UI can show the
 * spinner without holding the request open for ~30s.
 */
async function handleTriggerCustomersSync(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Customer sync is admin-only' });
  }
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: HEARTLAND_SYNC_FN_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({ trigger: 'customers-only' })
        ),
      })
    );
    return json(202, {
      status: 'triggered',
      message:
        'Customer sync started in the background. Refresh the page in 30-60s to see updated counts.',
    });
  } catch (err) {
    console.error('Customer sync trigger failed:', (err as Error).message);
    return json(500, { error: 'Failed to trigger sync' });
  }
}

/**
 * POST /campaign/send
 *
 * Body: {
 *   subject: string;
 *   htmlBody: string;      // can include <img src="data:image/..."> inline images
 *   textBody?: string;     // optional plain-text fallback
 *   recipients: 'all' | 'selected';
 *   selectedIds?: number[];   // required when recipients === 'selected'
 *   testEmail?: string;       // if set, sends ONLY to this address as a preview
 * }
 *
 * Always respects the email + promotionalEmails + unsubscribed gates.
 * Sends one-by-one via SES so each email gets a unique unsubscribe token.
 * Rate-limited to ~10/sec to stay under the 14/sec SES throttle.
 */
async function handleCampaignSend(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Campaign send is admin-only' });
  }
  let body: {
    subject?: string;
    htmlBody?: string;
    textBody?: string;
    recipients?: 'all' | 'selected';
    selectedIds?: number[];
    testEmail?: string;
    /**
     * Recipient gate. 'strict' (default) requires `promotionalEmails===true`
     * AND `unsubscribed===false`. 'permissive' only requires email present
     * AND `unsubscribed===false` — used when the Heartland data has the
     * promo flag defaulted to false en masse and the admin wants to email
     * the established-business-relationship list under CAN-SPAM. Both
     * modes ALWAYS honor explicit unsubscribes.
     */
    optInMode?: 'strict' | 'permissive';
    /**
     * Wave-send controls. When set, the handler sends only this many
     * recipients per call, sorted by customerId ASC. Pass `waveCursor`
     * (returned from the prior call) to resume after the last batch.
     */
    waveSize?: number;
    waveCursor?: number;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const subject = (body.subject ?? '').trim();
  const htmlBody = (body.htmlBody ?? '').trim();
  if (!subject || !htmlBody) {
    return json(400, { error: 'subject and htmlBody are required' });
  }

  const optInMode = body.optInMode === 'permissive' ? 'permissive' : 'strict';
  const waveSize = body.waveSize && body.waveSize > 0 ? Math.min(body.waveSize, 5000) : null;
  const waveCursor = body.waveCursor && body.waveCursor > 0 ? body.waveCursor : 0;

  function passesGate(c: Record<string, unknown>): boolean {
    if (c['unsubscribed'] === true) return false;
    if (optInMode === 'strict' && c['promotionalEmails'] !== true) return false;
    return true;
  }

  // Resolve recipients.
  type Recipient = { id: number; email: string; name: string };
  let recipients: Recipient[] = [];
  let nextWaveCursor: number | null = null;

  if (body.testEmail) {
    const e = body.testEmail.trim();
    if (!e || !e.includes('@')) {
      return json(400, { error: 'testEmail must be a valid address' });
    }
    recipients.push({ id: 0, email: e, name: 'Test recipient' });
  } else if (body.recipients === 'selected') {
    const ids = Array.isArray(body.selectedIds) ? body.selectedIds : [];
    if (ids.length === 0) {
      return json(400, { error: 'selectedIds is required when recipients=selected' });
    }
    if (ids.length > 5000) {
      return json(400, { error: 'Maximum 5000 recipients per send' });
    }
    for (const id of ids) {
      try {
        const res = await docClient.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: { userId: OWNER_USER_ID, sk: customerSk(id) },
          })
        );
        if (!res.Item) continue;
        const c = res.Item as Record<string, unknown>;
        const email = String(c['email'] ?? '').trim();
        if (!email) continue;
        if (!passesGate(c)) continue;
        recipients.push({
          id: Number(c['customerId']),
          email,
          name: String(c['name'] ?? ''),
        });
      } catch {
        /* skip */
      }
    }
  } else if (body.recipients === 'all') {
    // Scan all customers, apply gate, sort by customerId ASC, then page.
    const collected: Recipient[] = [];
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
          ExclusiveStartKey: exclusiveStartKey,
        })
      );
      for (const item of res.Items ?? []) {
        const c = item as Record<string, unknown>;
        const email = String(c['email'] ?? '').trim();
        if (!email) continue;
        if (!passesGate(c)) continue;
        collected.push({
          id: Number(c['customerId']),
          email,
          name: String(c['name'] ?? ''),
        });
      }
      if (!res.LastEvaluatedKey) break;
      exclusiveStartKey = res.LastEvaluatedKey;
      if (collected.length >= 20000) break;
    }
    collected.sort((a, b) => a.id - b.id);

    // Apply wave windowing if requested.
    if (waveSize) {
      const startIdx = collected.findIndex((r) => r.id > waveCursor);
      const window =
        startIdx === -1 ? [] : collected.slice(startIdx, startIdx + waveSize);
      recipients = window;
      // Set the cursor for the next wave to the LAST customerId we'll
      // process this turn. The next call passes that as waveCursor.
      const last = window[window.length - 1];
      if (last && startIdx !== -1 && startIdx + waveSize < collected.length) {
        nextWaveCursor = last.id;
      }
    } else {
      recipients = collected;
    }
  } else {
    return json(400, {
      error: 'recipients must be "all" or "selected" (or pass testEmail)',
    });
  }

  if (recipients.length === 0) {
    const reason =
      optInMode === 'strict'
        ? 'No eligible recipients (need promotionalEmails=true and unsubscribed=false)'
        : 'No eligible recipients (need email and unsubscribed=false)';
    return json(400, { error: reason });
  }

  // Send.
  const sendResults = { sent: 0, failed: 0, errors: [] as string[] };
  const startedAt = Date.now();

  for (const r of recipients) {
    const unsubToken = signUnsubscribeToken(r.id, r.email);
    const unsubUrl = `${getSelfBaseUrl(event)}/campaign/unsubscribe?token=${encodeURIComponent(unsubToken)}`;

    const fullHtml = wrapCampaignHtml({
      bodyHtml: htmlBody,
      recipientName: r.name,
      unsubUrl,
    });
    const fullText = wrapCampaignText({
      bodyText: body.textBody ?? stripHtmlForText(htmlBody),
      unsubUrl,
    });

    try {
      await sesClient.send(
        new SendEmailCommand({
          FromEmailAddress: `Foot Solutions Flower Mound <${CAMPAIGN_FROM_ADDRESS}>`,
          ReplyToAddresses: [CAMPAIGN_REPLY_TO],
          Destination: { ToAddresses: [r.email] },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: {
                Html: { Data: fullHtml },
                Text: { Data: fullText },
              },
              Headers: [
                {
                  Name: 'List-Unsubscribe',
                  Value: `<${unsubUrl}>`,
                },
                {
                  Name: 'List-Unsubscribe-Post',
                  Value: 'List-Unsubscribe=One-Click',
                },
              ],
            },
          },
        })
      );
      sendResults.sent++;
    } catch (err) {
      sendResults.failed++;
      const msg = (err as Error).message;
      if (sendResults.errors.length < 5) sendResults.errors.push(msg);
      console.error(`Campaign send to ${r.email} failed:`, msg);
    }

    // Rate limit to ~10/sec — stays well under SES's 14/sec quota.
    await new Promise((res) => setTimeout(res, 100));
  }

  const durationMs = Date.now() - startedAt;
  return json(200, {
    sent: sendResults.sent,
    failed: sendResults.failed,
    errors: sendResults.errors,
    totalRecipients: recipients.length,
    durationMs,
    testMode: !!body.testEmail,
    optInMode,
    nextWaveCursor,
    hasMoreWaves: nextWaveCursor != null,
  });
}

/**
 * GET /campaign/unsubscribe?token=...
 *
 * Public (unauthenticated). Verifies the token signature, looks up the
 * customer row by id, sets `unsubscribed=true`, and returns a small
 * confirmation HTML page.
 */
async function handleCampaignUnsubscribe(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const token = event.queryStringParameters?.['token'] ?? '';
  const verified = verifyUnsubscribeToken(token);
  const html = (heading: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foot Solutions — Unsubscribe</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:48px 16px;text-align:center}.card{background:#fff;max-width:480px;margin:0 auto;padding:32px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{margin:0 0 12px;font-size:20px}p{color:#475569;line-height:1.5}.foot{margin-top:24px;font-size:12px;color:#94a3b8}</style></head><body><div class="card"><h1>${heading}</h1><p>${body}</p><p class="foot">${CAMPAIGN_STORE_NAME} · ${CAMPAIGN_STORE_ADDRESS}</p></div></body></html>`;

  if (!verified) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html(
        'Invalid unsubscribe link',
        "This link is malformed or has expired. If you'd like to stop receiving emails from us, reply to any of our messages with the word UNSUBSCRIBE and we'll remove you manually.",
      ),
    };
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: customerSk(verified.id) },
        UpdateExpression:
          'SET unsubscribed = :t, unsubscribedAt = :now',
        ExpressionAttributeValues: {
          ':t': true,
          ':now': new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    console.error('Unsubscribe write failed:', (err as Error).message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html(
        'Something went wrong',
        "We couldn't update your subscription right now. Please reply to one of our emails and we'll remove you manually.",
      ),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html(
      "You've been unsubscribed",
      `${verified.email} has been removed from our promotional email list. We're sorry to see you go — feel free to drop by ${CAMPAIGN_STORE_NAME} anytime.`,
    ),
  };
}

// ── Campaign helpers ─────────────────────────────────────────────────

function getSelfBaseUrl(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  // Use the same API Gateway origin the request came in on so the
  // unsubscribe link resolves to the public route on the same API.
  const host = event.headers?.['host'] ?? event.headers?.['Host'] ?? '';
  const proto =
    event.headers?.['x-forwarded-proto'] ??
    event.headers?.['X-Forwarded-Proto'] ??
    'https';
  return host ? `${proto}://${host}` : '';
}

function signUnsubscribeToken(id: number, email: string): string {
  const payload = `${id}.${email}`;
  const sig = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifyUnsubscribeToken(token: string):
  | { id: number; email: string }
  | null {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(payload)
    .digest('base64url');
  if (expected !== sig) return null;
  const [idStr, email] = payload.split('.');
  if (!idStr || !email) return null;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id < 0) return null;
  return { id, email };
}

function wrapCampaignHtml({
  bodyHtml,
  recipientName,
  unsubUrl,
}: {
  bodyHtml: string;
  recipientName: string;
  unsubUrl: string;
}): string {
  // Add a bit of header + a CAN-SPAM-compliant footer with the store
  // address and the unsubscribe link.
  // Heartland stores names in ALL CAPS, so title-case the first name
  // for a friendlier "Hi Kathy," instead of "Hi KATHY,". Keep apostrophes
  // and hyphens lowercase-after-cap (O'Donnell, Mary-Anne).
  const firstName = recipientName ? recipientName.trim().split(/\s+/)[0] ?? '' : '';
  const friendlyFirst = firstName
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  const greeting = friendlyFirst
    ? `<p style="margin:0 0 16px">Hi ${escapeHtml(friendlyFirst)},</p>`
    : '<p style="margin:0 0 16px">Hi there,</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1e293b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc"><tr><td align="center" style="padding:32px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <tr><td style="padding:24px 32px 8px 32px;border-bottom:1px solid #e2e8f0">
      <p style="margin:0;font-size:18px;font-weight:600;color:#1e293b">Foot Solutions Flower Mound</p>
      <p style="margin:4px 0 0;font-size:12px;color:#64748b">${CAMPAIGN_STORE_ADDRESS}</p>
    </td></tr>
    <tr><td style="padding:24px 32px 24px 32px;font-size:15px;line-height:1.55;color:#1e293b">
      ${greeting}
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.5">
      <p style="margin:0">Questions? Reply to this email or contact <a href="mailto:${CAMPAIGN_REPLY_TO}" style="color:#2563eb">${CAMPAIGN_REPLY_TO}</a>.</p>
      <p style="margin:8px 0 0">${CAMPAIGN_STORE_NAME} · ${CAMPAIGN_STORE_ADDRESS}</p>
      <p style="margin:8px 0 0">You're receiving this email because you opted in at our store. <a href="${unsubUrl}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function wrapCampaignText({
  bodyText,
  unsubUrl,
}: {
  bodyText: string;
  unsubUrl: string;
}): string {
  return [
    bodyText,
    '',
    '---',
    `${CAMPAIGN_STORE_NAME}`,
    `${CAMPAIGN_STORE_ADDRESS}`,
    `Reply to: ${CAMPAIGN_REPLY_TO}`,
    `Unsubscribe: ${unsubUrl}`,
  ].join('\n');
}

function stripHtmlForText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}



// ── AWS Cost Tracker (admin-only) ─────────────────────────────────────
//
// GET /admin/aws-costs
//   Returns month-to-date + last-30-day totals + per-service breakdown,
//   filtered by the Project tag so we only count this app's spend.
//   Cached in DynamoDB for 12 hours (Cost Explorer data updates ~3x/day,
//   and each GetCostAndUsage call costs $0.01 — caching keeps it cheap).

const COST_CACHE_SK = 'COSTS#LATEST';
const COST_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COST_PROJECT_TAG = 'foot-solutions-platform';

interface AwsCostSummary {
  generatedAt: string;
  monthToDateTotal: number;
  last30DaysTotal: number;
  currency: string;
  monthStart: string;
  monthEnd: string;
  byService: Array<{ service: string; cost: number }>;
  filteredByTag: boolean; // true if we successfully scoped to the Project tag
  notes?: string;
}

async function getCachedCosts(): Promise<AwsCostSummary | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: COST_CACHE_SK },
    })
  );
  return ((r.Item as unknown) as AwsCostSummary) ?? null;
}

async function saveCachedCosts(summary: AwsCostSummary): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: COST_CACHE_SK, ...summary },
    })
  );
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchAwsCosts(): Promise<AwsCostSummary> {
  const now = new Date();
  // Cost Explorer expects YYYY-MM-DD with the End being EXCLUSIVE.
  const monthStart = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600 * 1000));
  const thirtyDaysAgo = ymd(new Date(now.getTime() - 30 * 24 * 3600 * 1000));

  // Try with the Project tag filter first. If tag is not yet activated for cost
  // allocation, fall back to unfiltered totals (slightly less accurate but works).
  const tagFilter = {
    Tags: { Key: 'Project', Values: [COST_PROJECT_TAG] },
  };

  let filteredByTag = true;
  let mtdTotal = 0;
  let last30Total = 0;
  let byService: Array<{ service: string; cost: number }> = [];
  let currency = 'USD';
  let notes: string | undefined;

  try {
    // 1. Month-to-date total + per-service breakdown
    const mtdResp = await ceClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: monthStart, End: tomorrow },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: tagFilter,
      })
    );

    const groups = mtdResp.ResultsByTime?.[0]?.Groups ?? [];
    for (const g of groups) {
      const service = g.Keys?.[0] ?? 'Unknown';
      const amount = g.Metrics?.['UnblendedCost']?.Amount;
      const unit = g.Metrics?.['UnblendedCost']?.Unit;
      if (unit) currency = unit;
      const cost = amount ? parseFloat(amount) : 0;
      mtdTotal += cost;
      if (cost > 0) byService.push({ service, cost });
    }
    byService.sort((a, b) => b.cost - a.cost);

    // 2. Last 30 days total (no group-by — just one total number)
    const last30Resp = await ceClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: thirtyDaysAgo, End: tomorrow },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter: tagFilter,
      })
    );
    for (const r of last30Resp.ResultsByTime ?? []) {
      const amt = r.Total?.['UnblendedCost']?.Amount;
      if (amt) last30Total += parseFloat(amt);
    }

    // If tag filter returned nothing, the Project tag probably isn't activated
    // for cost allocation yet. Fall back to unfiltered.
    if (mtdTotal === 0 && last30Total === 0 && byService.length === 0) {
      filteredByTag = false;
      notes = 'Project tag not yet activated for cost allocation. Showing total account costs. Activate the "Project" tag in AWS Billing Console → Cost Allocation Tags to scope to this app only.';
      const fallbackMtd = await ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: monthStart, End: tomorrow },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        })
      );
      for (const g of fallbackMtd.ResultsByTime?.[0]?.Groups ?? []) {
        const service = g.Keys?.[0] ?? 'Unknown';
        const amount = g.Metrics?.['UnblendedCost']?.Amount;
        const unit = g.Metrics?.['UnblendedCost']?.Unit;
        if (unit) currency = unit;
        const cost = amount ? parseFloat(amount) : 0;
        mtdTotal += cost;
        if (cost > 0) byService.push({ service, cost });
      }
      byService.sort((a, b) => b.cost - a.cost);
      const fallback30 = await ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: thirtyDaysAgo, End: tomorrow },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
        })
      );
      for (const r of fallback30.ResultsByTime ?? []) {
        const amt = r.Total?.['UnblendedCost']?.Amount;
        if (amt) last30Total += parseFloat(amt);
      }
    }
  } catch (err) {
    console.error('Cost Explorer call failed:', (err as Error).message);
    throw err;
  }

  return {
    generatedAt: new Date().toISOString(),
    monthToDateTotal: Math.round(mtdTotal * 100) / 100,
    last30DaysTotal: Math.round(last30Total * 100) / 100,
    currency,
    monthStart,
    monthEnd: tomorrow,
    byService: byService.map((s) => ({ ...s, cost: Math.round(s.cost * 100) / 100 })),
    filteredByTag,
    notes,
  };
}

async function handleAwsCosts(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!isAdminCaller(event)) {
    return json(403, { error: 'Cost data is admin-only' });
  }

  const refresh = event.queryStringParameters?.['refresh'] === 'true';

  if (!refresh) {
    const cached = await getCachedCosts();
    if (cached && Date.now() - new Date(cached.generatedAt).getTime() < COST_CACHE_TTL_MS) {
      return json(200, { ...cached, fromCache: true });
    }
  }

  try {
    const summary = await fetchAwsCosts();
    await saveCachedCosts(summary);
    return json(200, { ...summary, fromCache: false });
  } catch (err) {
    return json(500, { error: `Failed to fetch costs: ${(err as Error).message}` });
  }
}

// ── Main route handler ────────────────────────────────────────────────

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
    case 'GET /pos/vendor-health':
      return handleVendorHealth();
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
    case 'POST /pos/vendor-comment-reply':
      return handleVendorCommentReplyNotify(event);

    case 'POST /pos/vendor-comment-add':
      return handleVendorCommentAddNotify(event);

    // ── Campaign / customers (admin-only — see handler) ─────────────
    case 'GET /pos/customers':
      return handleGetCustomers(event);
    case 'GET /pos/customers/{id}/history':
      return handleGetCustomerHistory(event);
    case 'POST /pos/customers/sync':
      return handleTriggerCustomersSync(event);
    case 'POST /campaign/send':
      return handleCampaignSend(event);
    case 'GET /campaign/unsubscribe':
      return handleCampaignUnsubscribe(event);

    case 'GET /admin/aws-costs':
      return handleAwsCosts(event);
    case 'GET /admin/settings':
      return handleGetAdminSettings();
    case 'PUT /admin/settings':
      return handlePutAdminSettings(event);
    case 'GET /admin/emails':
      return handleGetEmails(event);
    case 'POST /admin/test-email':
      return handleTestEmail(event);
    default:
      return json(404, { error: 'Route not found' });
  }
};
