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
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

async function handleDashboard(): Promise<APIGatewayProxyResultV2> {
  const today = todayStr();
  const last30 = await queryDailyRollups(daysAgo(30), today);
  const last7 = last30.filter((r) => r.date >= daysAgo(7));
  const todayRollups = last30.filter((r) => r.date === today);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const ytd = await queryDailyRollups(yearStart, today);

  const status = await getSyncStatus();

  return json(200, {
    today: sumRollups(todayRollups),
    last7Days: sumRollups(last7),
    last30Days: sumRollups(last30),
    yearToDate: sumRollups(ytd),
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
  const rollups = await queryDailyRollups(`${year}-01-01`, `${year}-12-31`);
  const totals = sumRollups(rollups);

  const grossWithTax = totals.totalAmount;
  const taxableBasis = grossWithTax / 1.0825;
  const salesTaxCollected = grossWithTax - taxableBasis;

  return json(200, {
    taxYear: year,
    source: 'heartland-payments',
    importedFields: {
      totalRevenue: Math.round(taxableBasis * 100) / 100,
      salesTaxCollected: Math.round(salesTaxCollected * 100) / 100,
    },
    metadata: {
      grossAmountIncludingTax: Math.round(grossWithTax * 100) / 100,
      ticketCount: totals.ticketCount,
      daysWithSales: rollups.length,
      assumedTaxRate: 0.0825,
      note: 'Tax basis derived by reverse-calculating from gross payments at 8.25% Denton combined rate. For exact figures, use sales tax returns.',
    },
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
      summary: { totalItems: 0, activeItems: 0, liveItems: 0, itemsWithCostData: 0, overallAvgMarginPct: 0 },
      byDepartment: [],
      byBrand: [],
      topMarginItems: [],
      lowMarginItems: [],
      cached: false,
      cachedAt: null,
      notReady: true,
      message: 'Inventory has not been synced yet. Use the "Sync now" button to populate.',
    });
  }
  const data = result.Item['data'] as InventoryCacheData;
  return json(200, {
    ...data,
    cached: true,
    cachedAt: result.Item['cachedAt'],
  });
}

async function handleStaff(): Promise<APIGatewayProxyResultV2> {
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

  const today = todayStr();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const rollups = await queryDailyRollups(yearStart, today);

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
      ytdAmount: Math.round(v.amount * 100) / 100,
      activeDays: v.days,
      avgPerDay: v.days > 0 ? Math.round((v.amount / v.days) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.ytdAmount - a.ytdAmount);

  const status = await getSyncStatus();

  return json(200, {
    year: today.slice(0, 4),
    staff,
    totalUsers: users.length,
    syncInfo: {
      lastSyncAt: status?.['completedAt'] ?? null,
      status: status?.['status'] ?? 'never',
    },
    asOf: new Date().toISOString(),
  });
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
      return handleDashboard();
    case 'GET /pos/sales':
      return handleSalesByYear(event);
    case 'GET /pos/import-tax-defaults':
      return handleImportTaxDefaults(event);
    case 'GET /pos/analytics':
      return handleAnalytics(event);
    case 'GET /pos/inventory':
      return handleInventory();
    case 'GET /pos/staff':
      return handleStaff();
    case 'GET /pos/sync-status':
      return handleSyncStatus();
    case 'POST /pos/sync':
      return handleTriggerSync();
    default:
      return json(404, { error: 'Route not found' });
  }
};
