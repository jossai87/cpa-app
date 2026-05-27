"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lambda/heartland/index.ts
var heartland_exports = {};
__export(heartland_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(heartland_exports);
var import_client_dynamodb2 = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb2 = require("@aws-sdk/lib-dynamodb");
var import_client_lambda = require("@aws-sdk/client-lambda");
var import_client_sesv2 = require("@aws-sdk/client-sesv2");
var import_client_cost_explorer = require("@aws-sdk/client-cost-explorer");

// lambda/node_modules/uuid/dist/esm-node/rng.js
var import_crypto = __toESM(require("crypto"));
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    import_crypto.default.randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// lambda/node_modules/uuid/dist/esm-node/stringify.js
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]];
}

// lambda/node_modules/uuid/dist/esm-node/native.js
var import_crypto2 = __toESM(require("crypto"));
var native_default = {
  randomUUID: import_crypto2.default.randomUUID
};

// lambda/node_modules/uuid/dist/esm-node/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random || (options.rng || rng)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default = v4;

// lambda/gmail-analysis/cache.ts
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");
var dynamoClient = new import_client_dynamodb.DynamoDBClient({ region: "us-east-1" });
var docClient = import_lib_dynamodb.DynamoDBDocumentClient.from(dynamoClient);
var TABLE_NAME = process.env["TABLE_NAME"];
var OWNER_USER_ID = process.env["OWNER_USER_ID"];
function brandSlug(b) {
  return b.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function inDateWindow(dateOnly, since, until) {
  if (since && dateOnly < since) return false;
  if (until && dateOnly > until) return false;
  return true;
}
async function cacheQuery(args) {
  const limit = Math.min(args.limit ?? 25, 100);
  const since = args.since ?? "2000-01-01";
  const until = args.until ?? "2999-12-31";
  let skPrefix;
  if (args.vendor) {
    skPrefix = `GMAIL#VENDOR#${brandSlug(args.vendor)}#`;
  } else if (args.threadId) {
    skPrefix = `GMAIL#THREAD#${args.threadId}#`;
  } else if (args.kind) {
    skPrefix = `GMAIL#KIND#${args.kind.toLowerCase()}#`;
  } else {
    skPrefix = "GMAIL#MSG#";
  }
  const skLow = `${skPrefix}${since}`;
  const skHigh = `${skPrefix}${until}\uFFFF`;
  let exclusiveStartKey;
  const collected = [];
  while (collected.length < limit * 4) {
    const res = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :uid AND sk BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":uid": OWNER_USER_ID, ":lo": skLow, ":hi": skHigh },
        ExclusiveStartKey: exclusiveStartKey,
        Limit: 200
      })
    );
    for (const item of res.Items ?? []) {
      const row = item;
      if (args.text) {
        const t = args.text.toLowerCase();
        const hay = `${row.subject ?? ""} ${row.snippet ?? ""}`.toLowerCase();
        if (!hay.includes(t)) continue;
      }
      if (args.from) {
        if (!(row.from ?? "").toLowerCase().includes(args.from.toLowerCase())) continue;
      }
      if (!inDateWindow(row.dateOnly, args.since, args.until)) continue;
      collected.push(row);
      if (collected.length >= limit * 4) break;
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }
  const byId = /* @__PURE__ */ new Map();
  for (const r of collected) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const deduped = [...byId.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
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
      sourceAccount: r.sourceAccount
    }))
  };
}
async function cacheVendorActivity(vendor, days = 90) {
  const since = new Date(Date.now() - days * 86400 * 1e3).toISOString().slice(0, 10);
  const result = await cacheQuery({ vendor, since, limit: 100 });
  const senders = /* @__PURE__ */ new Map();
  const subjects = /* @__PURE__ */ new Map();
  let last = null;
  for (const r of result.rows) {
    if (r.from) senders.set(r.from, (senders.get(r.from) ?? 0) + 1);
    if (r.subject) subjects.set(r.subject, (subjects.get(r.subject) ?? 0) + 1);
    if (!last || (r.date ?? "") > last) last = r.date ?? null;
  }
  return {
    vendor,
    messageCount: result.rows.length,
    lastContactDate: last,
    topSenders: [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([from, count]) => ({ from, count })),
    topSubjects: [...subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([subject, count]) => ({ subject, count })),
    recentMessageIds: result.rows.slice(0, 10).map((r) => r.id)
  };
}
async function cacheStats() {
  let exclusiveStartKey;
  let total = 0;
  let oldest = null;
  let newest = null;
  const byKind = {};
  while (true) {
    const res = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :uid AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":uid": OWNER_USER_ID, ":p": "GMAIL#MSG#" },
        ProjectionExpression: "dateOnly, kind",
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const it of res.Items ?? []) {
      total++;
      const d = it["dateOnly"];
      if (d) {
        if (!oldest || d < oldest) oldest = d;
        if (!newest || d > newest) newest = d;
      }
      const k = it["kind"] ?? "unclassified";
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    if (!res.LastEvaluatedKey) break;
    exclusiveStartKey = res.LastEvaluatedKey;
  }
  return { totalCanonical: total, oldestDate: oldest, newestDate: newest, byKind };
}

// lambda/heartland/index.ts
var crypto3 = __toESM(require("crypto"));
var dynamoClient2 = new import_client_dynamodb2.DynamoDBClient({ region: "us-east-1" });
var docClient2 = import_lib_dynamodb2.DynamoDBDocumentClient.from(dynamoClient2);
var lambdaClient = new import_client_lambda.LambdaClient({ region: "us-east-1" });
var sesClient = new import_client_sesv2.SESv2Client({ region: "us-east-1" });
var ceClient = new import_client_cost_explorer.CostExplorerClient({ region: "us-east-1" });
var TABLE_NAME2 = process.env["TABLE_NAME"];
var SYNC_FUNCTION_NAME = process.env["SYNC_FUNCTION_NAME"] ?? "";
var OWNER_USER_ID2 = process.env["OWNER_USER_ID"];
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
var STORE_TIMEZONE = "America/Chicago";
var HEARTLAND_EXTENSION_BASE_URL = "http://localhost:2773";
async function getHeartlandSecret() {
  const url = `${HEARTLAND_EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent("foot-solutions/heartland/api-token")}`;
  const res = await fetch(url, {
    headers: { "X-Aws-Parameters-Secrets-Token": process.env["AWS_SESSION_TOKEN"] ?? "" }
  });
  if (!res.ok) throw new Error(`Failed to load Heartland secret: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.SecretString);
}
async function fetchFromHeartland(path) {
  const secret = await getHeartlandSecret();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${secret.baseUrl}/${path}${sep}per_page=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secret.token}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Heartland ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}
function centralDateString(d) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(d);
}
function todayStr() {
  return centralDateString(/* @__PURE__ */ new Date());
}
function daysAgo(n) {
  const d = /* @__PURE__ */ new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return centralDateString(d);
}
async function queryDailyRollups(fromDate, toDate) {
  const result = await docClient2.send(
    new import_lib_dynamodb2.QueryCommand({
      TableName: TABLE_NAME2,
      KeyConditionExpression: "userId = :uid AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":uid": OWNER_USER_ID2,
        ":from": `POS#DAILY#${fromDate}`,
        ":to": `POS#DAILY#${toDate}`
      }
    })
  );
  return (result.Items ?? []).map((item) => item["rollup"]);
}
function sumRollups(rollups) {
  let totalAmount = 0;
  let ticketCount = 0;
  for (const r of rollups) {
    totalAmount += r.totalAmount;
    ticketCount += r.count;
  }
  return { totalAmount, ticketCount };
}
async function getSyncStatus() {
  const r = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#SYNC#STATUS" }
    })
  );
  return r.Item ?? null;
}
function buildHourlyTotals(rollups) {
  const hours = Array(24).fill(0);
  for (const r of rollups) {
    for (const [h, amt] of Object.entries(r.byHour ?? {})) {
      const idx = parseInt(h, 10);
      if (idx >= 0 && idx < 24) hours[idx] = (hours[idx] ?? 0) + amt;
    }
  }
  return hours;
}
function sumRollupsExtended(rollups) {
  return sumRollups(rollups);
}
async function handleDashboard(event) {
  const today = todayStr();
  const year = today.slice(0, 4);
  const lastYear = String(parseInt(year, 10) - 1);
  const paramStart = event.queryStringParameters?.["start"];
  const paramEnd = event.queryStringParameters?.["end"];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const rangeStart = paramStart && dateRe.test(paramStart) ? paramStart : null;
  const rangeEnd = paramEnd && dateRe.test(paramEnd) ? paramEnd : null;
  const effectiveStart = rangeStart ?? daysAgo(30);
  const effectiveEnd = rangeEnd ?? today;
  const yearStart = `${year}-01-01`;
  const [rangeRollups, ytd] = await Promise.all([
    queryDailyRollups(effectiveStart, effectiveEnd),
    queryDailyRollups(yearStart, today)
  ]);
  const todayRollups = rangeRollups.filter((r) => r.date === today);
  const last7Rollups = rangeRollups.filter((r) => r.date >= daysAgo(7));
  const last30Rollups = rangeRollups.filter((r) => r.date >= daysAgo(30));
  function shiftYearBack(dateStr) {
    const d = /* @__PURE__ */ new Date(dateStr + "T12:00:00");
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
    queryDailyRollups(lastYearToday, lastYearToday)
  ]);
  const lyLast7Start = shiftYearBack(daysAgo(7));
  const lyLast30Start = shiftYearBack(daysAgo(30));
  const lyLast7 = lyRangeRollups.filter((r) => r.date >= lyLast7Start);
  const lyLast30 = lyRangeRollups.filter((r) => r.date >= lyLast30Start);
  const todayHourly = buildHourlyTotals(todayRollups.length ? todayRollups : rangeRollups.filter((r) => r.date === effectiveEnd));
  const lastYearTodayHourly = buildHourlyTotals(lyTodayRollups);
  const [purchasingResult, inventoryResult] = await Promise.all([
    docClient2.send(new import_lib_dynamodb2.GetCommand({ TableName: TABLE_NAME2, Key: { userId: OWNER_USER_ID2, sk: "POS#PURCHASING#ORDERS" } })),
    docClient2.send(new import_lib_dynamodb2.GetCommand({ TableName: TABLE_NAME2, Key: { userId: OWNER_USER_ID2, sk: "POS#INVENTORY#CATALOG" } }))
  ]);
  const openOrderCount = purchasingResult.Item?.["vendorRank"]?.reduce((s, r) => s + (r.openOrders ?? 0), 0) ?? 0;
  const lowStockCount = inventoryResult.Item?.["data"]?.["lowStockItems"]?.length ?? 0;
  const status = await getSyncStatus();
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
      selectedRange: lySelectedRange
    },
    hourly: {
      today: todayHourly,
      lastYear: lastYearTodayHourly
    },
    alerts: {
      openOrders: openOrderCount,
      lowStock: lowStockCount
    },
    syncInfo: {
      lastSyncAt: status?.["completedAt"] ?? null,
      // 'ok' | 'partial' | 'error' | 'never' — used by the UI's
      // "Synced N min ago" badge to show a yellow warning when the
      // most recent sync hit upstream errors (e.g. Heartland 500
      // for payments) so the cards aren't shown as fresh.
      status: status?.["status"] ?? "never",
      // Per-section error messages so the UI / agent can surface the
      // exact upstream issue (e.g. "Heartland payments API: 500
      // internal_error") instead of silently showing stale data.
      sectionErrors: extractSectionErrors(status)
    },
    asOf: (/* @__PURE__ */ new Date()).toISOString()
  });
}
function extractSectionErrors(status) {
  if (!status || typeof status !== "object") return {};
  const out = {};
  const sectionNames = ["payments", "inventory", "purchasing", "reporting", "staff"];
  for (const name of sectionNames) {
    const s = status[name];
    if (s && typeof s === "object" && "error" in s) {
      const err = s.error;
      if (typeof err === "string") out[name] = err;
    }
  }
  return out;
}
async function handleSalesByYear(event) {
  const yearStr = event.queryStringParameters?.["year"];
  const year = yearStr ? parseInt(yearStr, 10) : (/* @__PURE__ */ new Date()).getFullYear();
  if (!year || year < 2020 || year > 2099) {
    return json(400, { error: "Invalid year parameter" });
  }
  const rollups = await queryDailyRollups(`${year}-01-01`, `${year}-12-31`);
  const totals = sumRollups(rollups);
  return json(200, {
    year,
    totalRevenue: totals.totalAmount,
    ticketCount: totals.ticketCount,
    daysWithSales: rollups.length
  });
}
async function handleImportTaxDefaults(event) {
  const yearStr = event.queryStringParameters?.["taxYear"];
  const year = yearStr ? parseInt(yearStr, 10) : (/* @__PURE__ */ new Date()).getFullYear();
  if (!year || year < 2020 || year > 2099) {
    return json(400, { error: "Invalid taxYear parameter" });
  }
  const userId = event.requestContext.authorizer.jwt.claims["sub"];
  const rollups = await queryDailyRollups(`${year}-01-01`, `${year}-12-31`);
  const grossWithTax = rollups.reduce((s, r) => s + r.totalAmount, 0);
  const ticketCount = rollups.reduce((s, r) => s + r.count, 0);
  const totalDiscounts = rollups.reduce((s, r) => s + (r.totalDiscounts ?? 0), 0);
  const taxableBasis = grossWithTax / 1.0825;
  const salesTaxCollected = grossWithTax - taxableBasis;
  const paymentTypeTotals = {};
  for (const r of rollups) {
    for (const [pt, v] of Object.entries(r.byPaymentType ?? {})) {
      if (!paymentTypeTotals[pt]) paymentTypeTotals[pt] = { count: 0, amount: 0 };
      paymentTypeTotals[pt].count += v.count;
      paymentTypeTotals[pt].amount += v.amount;
    }
  }
  const ptResult = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#PAYMENT_TYPES#LIST" }
    })
  );
  const ptList = ptResult.Item?.["types"] ?? [];
  const ptLabel = {};
  for (const p of ptList) ptLabel[String(p.id)] = p.name;
  const paymentMix = Object.entries(paymentTypeTotals).map(([id, v]) => ({
    name: ptLabel[id] ?? id,
    count: v.count,
    amount: Math.round(v.amount * 100) / 100
  })).sort((a, b) => b.amount - a.amount);
  let netSales = null;
  let netMargin = null;
  let netQtySold = null;
  let cogsEstimate = null;
  let topBrands = [];
  const reportingYear = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: `POS#REPORTING#YEAR#${year}` }
    })
  );
  if (reportingYear.Item) {
    const brandRows = reportingYear.Item["brandRows"] ?? [];
    const totalsRows = reportingYear.Item["totalsRows"] ?? [];
    if (totalsRows.length > 0) {
      netSales = totalsRows.reduce((s, r) => s + (r["source_sales.net_sales"] ?? 0), 0);
      netMargin = totalsRows.reduce((s, r) => s + (r["source_sales.net_margin"] ?? 0), 0);
    } else {
      netSales = 0;
      netMargin = 0;
      for (const r of brandRows) {
        netSales += r["source_sales.net_sales"] ?? 0;
        netMargin += r["source_sales.net_margin"] ?? 0;
      }
    }
    netQtySold = 0;
    for (const r of brandRows) {
      netQtySold += r["source_sales.net_qty_sold"] ?? 0;
    }
    cogsEstimate = netMargin > 0 ? Math.max(0, netSales - netMargin) : null;
    const merged = /* @__PURE__ */ new Map();
    for (const r of brandRows) {
      const raw = (r["item.custom@brand"] ?? "").trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      let m = merged.get(key);
      if (!m) {
        m = { brand: raw, netSales: 0, netMargin: 0 };
        merged.set(key, m);
      }
      m.netSales += r["source_sales.net_sales"] ?? 0;
      m.netMargin += r["source_sales.net_margin"] ?? 0;
    }
    topBrands = Array.from(merged.values()).sort((a, b) => b.netSales - a.netSales).slice(0, 15).map((b) => ({
      brand: b.brand,
      netSales: Math.round(b.netSales * 100) / 100,
      netMargin: Math.round(b.netMargin * 100) / 100
    }));
  }
  const currentYear = parseInt(todayStr().slice(0, 4), 10);
  let endingInventoryCost = null;
  if (year === currentYear) {
    const invResult = await docClient2.send(
      new import_lib_dynamodb2.GetCommand({
        TableName: TABLE_NAME2,
        Key: { userId: OWNER_USER_ID2, sk: "POS#INVENTORY#CATALOG" }
      })
    );
    if (invResult.Item) {
      const byDept = invResult.Item["byDepartment"] ?? [];
      const totalCost = byDept.reduce((s, d) => s + (d.totalCost ?? 0), 0);
      if (totalCost > 0) endingInventoryCost = Math.round(totalCost * 100) / 100;
    }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const totalRevenueImported = netSales != null ? round2(netSales) : round2(taxableBasis);
  const importedFields = {
    totalRevenue: totalRevenueImported,
    salesTaxCollected: round2(salesTaxCollected)
  };
  if (cogsEstimate != null && cogsEstimate > 0) {
    importedFields["cogs"] = round2(cogsEstimate);
  }
  if (endingInventoryCost != null) {
    importedFields["endingInventory"] = endingInventoryCost;
  }
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const summary = {
    taxYear: year,
    source: "heartland",
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
      avgMarginPct: netSales != null && netMargin != null && netSales > 0 ? Math.round(netMargin / netSales * 1e3) / 10 : null,
      endingInventoryCost,
      paymentMix,
      topBrands,
      reportingDataAvailable: netSales != null,
      inventoryDataAvailable: endingInventoryCost != null
    },
    note: netSales != null ? "totalRevenue uses Heartland Reporting Analyzer net sales (after discounts and returns) \u2014 matches what your CPA expects." : "totalRevenue is reverse-calculated from gross payments at 8.25% Denton combined rate. For exact figures, use sales tax returns or the Heartland Reporting Analyzer once it has synced for this year."
  };
  const docId = v4_default();
  const fileName = `POS Import \u2014 Tax Year ${year} (${generatedAt.slice(0, 10)})`;
  try {
    await docClient2.send(
      new import_lib_dynamodb2.PutCommand({
        TableName: TABLE_NAME2,
        Item: {
          userId,
          sk: `DOC#${generatedAt}#${docId}`,
          docId,
          objectKey: `pos-import/${userId}/${docId}.json`,
          // synthetic — no real S3 object
          fileName,
          docType: "pos-import",
          contentType: "application/json",
          uploadedAt: generatedAt,
          // appliedTotals lets the form-hydration logic pick up these fields
          // automatically next visit (only if the user emptied them)
          appliedTotals: importedFields,
          flagged: [],
          bankName: null,
          periodStart: `${year}-01-01`,
          periodEnd: `${year}-12-31`,
          confidence: "high",
          notes: summary.note,
          autoClassified: false,
          autoClassifyResult: null,
          // Embed the rich summary so the CPA package can include it as a
          // standalone JSON file. Stored inline since DynamoDB items can be up
          // to 400KB and this payload is tiny (a few KB at most).
          posImportSummary: summary
        }
      })
    );
  } catch (err) {
    console.error("Failed to persist POS-import doc:", err.message);
    return json(200, {
      ...summary,
      docPersisted: false,
      docPersistError: err.message
    });
  }
  return json(200, {
    ...summary,
    docId,
    docPersisted: true
  });
}
async function handleAnalytics(event) {
  const daysParam = event.queryStringParameters?.["days"];
  const days = Math.min(365, Math.max(1, parseInt(daysParam ?? "90", 10)));
  const today = todayStr();
  const fromDate = daysAgo(days);
  const rollups = await queryDailyRollups(fromDate, today);
  const ptResult = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#PAYMENT_TYPES#LIST" }
    })
  );
  const paymentTypes = ptResult.Item?.["types"] ?? [];
  const ptMap = {};
  for (const pt of paymentTypes) ptMap[String(pt.id)] = pt.name;
  const paymentTotals = {};
  const hourTotals = {};
  const customerTotals = {};
  const repTotals = {};
  let totalDiscounts = 0;
  let totalAmount = 0;
  let totalCount = 0;
  for (const r of rollups) {
    totalAmount += r.totalAmount;
    totalCount += r.count;
    totalDiscounts += r.totalDiscounts ?? 0;
    for (const [typeId, v] of Object.entries(r.byPaymentType)) {
      if (!paymentTotals[typeId]) paymentTotals[typeId] = { amount: 0, count: 0 };
      paymentTotals[typeId].amount += v.amount;
      paymentTotals[typeId].count += v.count;
    }
    for (const [hour, amt] of Object.entries(r.byHour ?? {})) {
      hourTotals[hour] = (hourTotals[hour] ?? 0) + amt;
    }
    for (const [name, amt] of Object.entries(r.topCustomers ?? {})) {
      if (!customerTotals[name]) customerTotals[name] = { amount: 0, visits: 0 };
      customerTotals[name].amount += amt;
      customerTotals[name].visits += 1;
    }
    for (const [rep, amt] of Object.entries(r.bySalesRep ?? {})) {
      if (!repTotals[rep]) repTotals[rep] = { amount: 0, count: 0 };
      repTotals[rep].amount += amt;
      repTotals[rep].count += 1;
    }
  }
  const dailyTrend = rollups.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, amount: r.totalAmount, count: r.count }));
  const paymentMethods = Object.entries(paymentTotals).map(([id, v]) => ({
    id,
    name: ptMap[id] ?? `Type ${id}`,
    amount: Math.round(v.amount * 100) / 100,
    count: v.count,
    pct: totalAmount > 0 ? Math.round(v.amount / totalAmount * 1e3) / 10 : 0
  })).sort((a, b) => b.amount - a.amount);
  const hourlyHeatmap = Array.from({ length: 24 }, (_, i) => {
    const h = String(i).padStart(2, "0");
    const label = `${i === 0 ? 12 : i > 12 ? i - 12 : i}${i < 12 ? "am" : "pm"}`;
    return { hour: i, label, amount: Math.round((hourTotals[h] ?? 0) * 100) / 100 };
  });
  const topCustomers = Object.entries(customerTotals).filter(([name]) => name && name !== "null").map(([name, v]) => ({ name, amount: Math.round(v.amount * 100) / 100, visits: v.visits })).sort((a, b) => b.amount - a.amount).slice(0, 20);
  const bySalesRep = Object.entries(repTotals).map(([name, v]) => ({ name, amount: Math.round(v.amount * 100) / 100, count: v.count })).sort((a, b) => b.amount - a.amount);
  const status = await getSyncStatus();
  return json(200, {
    days,
    fromDate,
    toDate: today,
    summary: {
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalCount,
      avgTicket: totalCount > 0 ? Math.round(totalAmount / totalCount * 100) / 100 : 0
    },
    dailyTrend,
    paymentMethods,
    hourlyHeatmap,
    topCustomers,
    bySalesRep,
    discountSummary: {
      totalDiscounts: Math.round(totalDiscounts * 100) / 100,
      discountRate: totalAmount > 0 ? Math.round(totalDiscounts / (totalAmount + totalDiscounts) * 1e3) / 10 : 0,
      avgDiscountPerTicket: totalCount > 0 ? Math.round(totalDiscounts / totalCount * 100) / 100 : 0
    },
    syncInfo: {
      lastSyncAt: status?.["completedAt"] ?? null,
      status: status?.["status"] ?? "never"
    },
    asOf: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function handleInventory() {
  const result = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#INVENTORY#CATALOG" }
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
      message: 'Inventory has not been synced yet. Use the "Sync now" button to populate.'
    });
  }
  const data = result.Item["data"];
  return json(200, {
    ...data,
    cached: true,
    cachedAt: result.Item["cachedAt"]
  });
}
async function handleStaff(event) {
  const period = event.queryStringParameters?.["period"] ?? "ytd";
  const customStart = event.queryStringParameters?.["start"];
  const customEnd = event.queryStringParameters?.["end"];
  const today = todayStr();
  let fromDate;
  let toDate = today;
  let label;
  switch (period) {
    case "today":
      fromDate = today;
      label = "Today";
      break;
    case "7d":
      fromDate = daysAgo(6);
      label = "Last 7 days";
      break;
    case "30d":
      fromDate = daysAgo(29);
      label = "Last 30 days";
      break;
    case "monthly":
      fromDate = `${today.slice(0, 7)}-01`;
      label = "This month";
      break;
    case "custom":
      if (!customStart || !customEnd) {
        return json(400, { error: "Custom period requires start and end query params (YYYY-MM-DD)" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(customStart) || !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
        return json(400, { error: "Dates must be in YYYY-MM-DD format" });
      }
      fromDate = customStart;
      toDate = customEnd;
      label = `${customStart} \u2013 ${customEnd}`;
      break;
    case "ytd":
    default:
      fromDate = `${today.slice(0, 4)}-01-01`;
      label = "Year to date";
      break;
  }
  const usersResult = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#USERS#LIST" }
    })
  );
  const users = usersResult.Item?.["users"] ?? [];
  const userMap = {};
  for (const u of users) {
    const fullName = `${u.first_name} ${u.last_name}`.trim();
    userMap[u.login] = fullName || u.login;
    userMap[fullName] = fullName;
  }
  const rollups = await queryDailyRollups(fromDate, toDate);
  const repTotals = {};
  for (const r of rollups) {
    for (const [rep, amt] of Object.entries(r.bySalesRep ?? {})) {
      if (!repTotals[rep]) repTotals[rep] = { amount: 0, tax: 0, days: 0 };
      repTotals[rep].amount += amt;
      repTotals[rep].tax += r.taxBySalesRep?.[rep] ?? 0;
      repTotals[rep].days += 1;
    }
  }
  const staff = Object.entries(repTotals).map(([rep, v]) => {
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
      avgPerDay: v.days > 0 ? Math.round(amountExTax / v.days * 100) / 100 : 0
    };
  }).sort((a, b) => b.amount - a.amount);
  const status = await getSyncStatus();
  let beckyOrthoticCount = null;
  try {
    const analyzerPath = `reporting/analyzer?metrics[]=source_sales.net_qty_sold&groups[]=user.full_name&groups[]=item.custom@department&start_date=${fromDate}&end_date=${toDate}`;
    const data = await fetchFromHeartland(analyzerPath);
    let total = 0;
    for (const row of data.results ?? []) {
      const name = String(row["user.full_name"] ?? "").toLowerCase();
      const dept = String(row["item.custom@department"] ?? "").toLowerCase();
      const qty = Number(row["source_sales.net_qty_sold"] ?? 0);
      if (!name.includes("becky")) continue;
      if (!dept.includes("orthotic")) continue;
      if (qty > 0) total += qty;
    }
    beckyOrthoticCount = Math.round(total);
  } catch (err) {
    console.warn("beckyOrthoticCount fetch failed:", err.message);
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
      lastSyncAt: status?.["completedAt"] ?? null,
      status: status?.["status"] ?? "never"
    },
    asOf: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function handlePurchasing() {
  const [vendorsResult, ordersResult] = await Promise.all([
    docClient2.send(new import_lib_dynamodb2.GetCommand({ TableName: TABLE_NAME2, Key: { userId: OWNER_USER_ID2, sk: "POS#PURCHASING#VENDORS" } })),
    docClient2.send(new import_lib_dynamodb2.GetCommand({ TableName: TABLE_NAME2, Key: { userId: OWNER_USER_ID2, sk: "POS#PURCHASING#ORDERS" } }))
  ]);
  if (!vendorsResult.Item && !ordersResult.Item) {
    return json(200, {
      vendors: [],
      vendorRank: [],
      orders: [],
      totalOrders: 0,
      notReady: true,
      message: "Purchasing data has not been synced yet."
    });
  }
  const vendors = vendorsResult.Item?.["vendors"] ?? [];
  const vendorRank = vendorsResult.Item?.["vendorRank"] ?? [];
  const orders = ordersResult.Item?.["orders"] ?? [];
  const totalOrders = ordersResult.Item?.["totalOrders"] ?? 0;
  const openOrderCount = vendorRank.reduce((s, r) => s + (r.openOrders ?? 0), 0);
  return json(200, {
    vendors,
    vendorCount: vendors.length,
    vendorRank,
    orders,
    totalOrders,
    openOrderCount,
    cachedAt: ordersResult.Item?.["cachedAt"] ?? vendorsResult.Item?.["cachedAt"] ?? null
  });
}
async function handleReporting(event) {
  const result = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({ TableName: TABLE_NAME2, Key: { userId: OWNER_USER_ID2, sk: "POS#REPORTING#SALES" } })
  );
  if (!result.Item) {
    return json(200, {
      rows: [],
      notReady: true,
      message: "Reporting data has not been synced yet."
    });
  }
  const rows = result.Item["rows"] ?? [];
  const rawBrandRows = result.Item["brandRows"] ?? [];
  const monthRows = result.Item["monthRows"] ?? [];
  const returnRows = result.Item["returnRows"] ?? [];
  const customerRows = result.Item["customerRows"] ?? [];
  const totalsRows = result.Item["totalsRows"] ?? [];
  const fromDate = result.Item["fromDate"];
  const toDate = result.Item["toDate"];
  const yearStart = result.Item["yearStart"];
  const brandTotals = /* @__PURE__ */ new Map();
  for (const r of rawBrandRows) {
    const rawBrand = r["item.custom@brand"]?.trim() ?? "";
    const isNull = rawBrand === "";
    const key = isNull ? "__NULL__" : rawBrand.toUpperCase();
    const displayName = isNull ? "(brand not set)" : rawBrand;
    let entry = brandTotals.get(key);
    if (!entry) {
      entry = { brand: displayName, netSales: 0, netQty: 0, netMargin: 0, transactions: 0, variants: /* @__PURE__ */ new Set(), isNullBrand: isNull };
      brandTotals.set(key, entry);
    }
    entry.netSales += r["source_sales.net_sales"] ?? 0;
    entry.netQty += r["source_sales.net_qty_sold"] ?? 0;
    entry.netMargin += r["source_sales.net_margin"] ?? 0;
    entry.transactions += r["source_sales.transaction_count"] ?? 0;
    if (!isNull) entry.variants.add(rawBrand);
    if (!isNull && rawBrand.length > 0 && rawBrand[0] === rawBrand[0]?.toUpperCase()) {
      entry.brand = rawBrand;
    }
  }
  const brandRows = Array.from(brandTotals.values()).map((b) => ({
    "item.custom@brand": b.brand,
    "source_sales.net_sales": Math.round(b.netSales * 100) / 100,
    "source_sales.net_qty_sold": b.netQty,
    "source_sales.net_margin": Math.round(b.netMargin * 100) / 100,
    "source_sales.transaction_count": b.transactions,
    variantCount: b.variants.size > 1 ? b.variants.size : void 0,
    variants: b.variants.size > 1 ? Array.from(b.variants) : void 0,
    isNullBrand: b.isNullBrand || void 0
  }));
  const dailyTotalSales = rows.reduce((s, r) => s + (r["source_sales.net_sales"] ?? 0), 0);
  const dailyTotalTxns = rows.reduce((s, r) => s + (r["source_sales.transaction_count"] ?? 0), 0);
  const totalsAgg = totalsRows.length > 0 ? totalsRows : null;
  const brandSumNetSales = Array.from(brandTotals.values()).reduce((s, b) => s + b.netSales, 0);
  const brandSumTxns = Array.from(brandTotals.values()).reduce((s, b) => s + b.transactions, 0);
  const ytdNetSales = totalsAgg ? totalsAgg.reduce((s, r) => s + (r["source_sales.net_sales"] ?? 0), 0) : brandSumNetSales;
  const ytdTransactions = totalsAgg ? totalsAgg.reduce((s, r) => s + (r["source_sales.transaction_count"] ?? 0), 0) : brandSumTxns;
  let ytdNetMargin = null;
  if (totalsAgg) {
    const sum = totalsAgg.reduce(
      (s, r) => s + (r["source_sales.net_margin"] ?? 0),
      0
    );
    ytdNetMargin = sum > 0 ? sum : null;
  }
  const marginAvailable = ytdNetMargin !== null;
  const repeatCustomers = customerRows.filter((r) => (r["source_sales.transaction_count"] ?? 0) > 1).length;
  const totalCustomers = customerRows.filter((r) => r["customer.public_id"]).length;
  const newCustomers = totalCustomers - repeatCustomers;
  const repeatRevenue = customerRows.filter((r) => (r["source_sales.transaction_count"] ?? 0) > 1).reduce((s, r) => s + (r["source_sales.net_sales"] ?? 0), 0);
  return json(200, {
    fromDate,
    toDate,
    yearStart,
    summary: {
      // YTD figures — what the user actually wants to see at the top of the Reporting tab
      totalNetSales: Math.round(ytdNetSales * 100) / 100,
      totalTransactions: ytdTransactions,
      totalNetMargin: ytdNetMargin !== null ? Math.round(ytdNetMargin * 100) / 100 : null,
      avgNetMarginPct: ytdNetMargin !== null && ytdNetSales > 0 ? Math.round(ytdNetMargin / ytdNetSales * 1e3) / 10 : null,
      marginAvailable,
      // 30-day window totals exposed separately so the daily section isn't misleading
      last30Days: {
        netSales: Math.round(dailyTotalSales * 100) / 100,
        transactions: dailyTotalTxns
      }
    },
    dailyRows: rows.sort(
      (a, b) => String(a["date.date"] ?? "").localeCompare(String(b["date.date"] ?? ""))
    ),
    monthRows: monthRows.sort(
      (a, b) => String(a["date.month_of_year"] ?? "").localeCompare(String(b["date.month_of_year"] ?? ""))
    ),
    brandRows: brandRows.sort(
      (a, b) => (b["source_sales.net_sales"] ?? 0) - (a["source_sales.net_sales"] ?? 0)
    ),
    returnRows: returnRows.sort(
      (a, b) => (b["source_sales.gross_returns"] ?? 0) - (a["source_sales.gross_returns"] ?? 0)
    ),
    customerInsights: {
      totalCustomers,
      repeatCustomers,
      newCustomers,
      repeatRate: totalCustomers > 0 ? Math.round(repeatCustomers / totalCustomers * 1e3) / 10 : 0,
      repeatRevenue: Math.round(repeatRevenue * 100) / 100,
      repeatRevenuePct: ytdNetSales > 0 ? Math.round(repeatRevenue / ytdNetSales * 1e3) / 10 : 0
    },
    cachedAt: result.Item["cachedAt"]
  });
}
async function handleInsights(event) {
  const today = todayStr();
  const currentYear = parseInt(today.slice(0, 4), 10);
  const yearParam = event.queryStringParameters?.["year"] ?? String(currentYear);
  const lookupYears = [];
  for (let y = currentYear; y >= currentYear - 3; y--) lookupYears.push(y);
  const yearItems = await Promise.all(
    lookupYears.map(
      (y) => docClient2.send(
        new import_lib_dynamodb2.GetCommand({
          TableName: TABLE_NAME2,
          Key: { userId: OWNER_USER_ID2, sk: `POS#REPORTING#YEAR#${y}` }
        })
      ).then((r) => ({ year: y, item: r.Item }))
    )
  );
  const availableYears = yearItems.filter((r) => r.item).map((r) => r.year);
  if (availableYears.length === 0) {
    return json(200, {
      notReady: true,
      message: "Year-aware insights have not been synced yet.",
      availableYears: []
    });
  }
  let selectedYears;
  let scopeLabel;
  if (yearParam === "all") {
    selectedYears = availableYears;
    scopeLabel = `All available (${availableYears.join(", ")})`;
  } else {
    const wanted = parseInt(yearParam, 10);
    if (!Number.isFinite(wanted) || !availableYears.includes(wanted)) {
      selectedYears = [availableYears[0]];
      scopeLabel = `${selectedYears[0]} (requested ${yearParam} not available)`;
    } else {
      selectedYears = [wanted];
      scopeLabel = String(wanted);
    }
  }
  const brandTotals = /* @__PURE__ */ new Map();
  const returnAccum = /* @__PURE__ */ new Map();
  const customerAccum = /* @__PURE__ */ new Map();
  let aggregateNetSales = 0;
  let aggregateNetMargin = 0;
  let aggregateTransactions = 0;
  let earliestFrom = "";
  let latestTo = "";
  let cachedAt = null;
  for (const r of yearItems) {
    if (!r.item || !selectedYears.includes(r.year)) continue;
    const item = r.item;
    if (!earliestFrom || item["fromDate"] && item["fromDate"] < earliestFrom) {
      earliestFrom = item["fromDate"];
    }
    if (!latestTo || item["toDate"] && item["toDate"] > latestTo) {
      latestTo = item["toDate"];
    }
    const ca = item["cachedAt"];
    if (ca && (!cachedAt || ca > cachedAt)) cachedAt = ca;
    const totalsRows = item["totalsRows"] ?? [];
    for (const tr of totalsRows) {
      aggregateNetSales += tr["source_sales.net_sales"] ?? 0;
      aggregateNetMargin += tr["source_sales.net_margin"] ?? 0;
      aggregateTransactions += tr["source_sales.transaction_count"] ?? 0;
    }
    const brandRows2 = item["brandRows"] ?? [];
    for (const br of brandRows2) {
      const rawBrand = (br["item.custom@brand"] ?? "").trim();
      const isNull = rawBrand === "";
      const key = isNull ? "__NULL__" : rawBrand.toUpperCase();
      const displayName = isNull ? "(brand not set)" : rawBrand;
      let entry = brandTotals.get(key);
      if (!entry) {
        entry = { brand: displayName, netSales: 0, netQty: 0, netMargin: 0, transactions: 0, variants: /* @__PURE__ */ new Set(), isNullBrand: isNull };
        brandTotals.set(key, entry);
      }
      entry.netSales += br["source_sales.net_sales"] ?? 0;
      entry.netQty += br["source_sales.net_qty_sold"] ?? 0;
      entry.netMargin += br["source_sales.net_margin"] ?? 0;
      entry.transactions += br["source_sales.transaction_count"] ?? 0;
      if (!isNull) entry.variants.add(rawBrand);
      if (!isNull && rawBrand.length > 0 && rawBrand[0] === rawBrand[0]?.toUpperCase()) {
        entry.brand = rawBrand;
      }
    }
    const returnRows2 = item["returnRows"] ?? [];
    for (const rr of returnRows2) {
      const rawBrand = (rr["item.custom@brand"] ?? "").trim();
      const key = rawBrand === "" ? "__NULL__" : rawBrand.toUpperCase();
      let entry = returnAccum.get(key);
      if (!entry) {
        entry = { brand: rawBrand || "(brand not set)", grossSales: 0, grossReturns: 0, grossQtySold: 0, grossQtyReturned: 0 };
        returnAccum.set(key, entry);
      }
      entry.grossSales += rr["source_sales.gross_sales"] ?? 0;
      entry.grossReturns += rr["source_sales.gross_returns"] ?? 0;
      entry.grossQtySold += rr["source_sales.gross_qty_sold"] ?? 0;
      entry.grossQtyReturned += rr["source_sales.gross_qty_returned"] ?? 0;
    }
    const customerRows = item["customerRows"] ?? [];
    for (const cr of customerRows) {
      const pid = cr["customer.public_id"] ?? "";
      if (!pid) continue;
      let entry = customerAccum.get(pid);
      if (!entry) {
        entry = { publicId: pid, netSales: 0, transactions: 0 };
        customerAccum.set(pid, entry);
      }
      entry.netSales += cr["source_sales.net_sales"] ?? 0;
      entry.transactions += cr["source_sales.transaction_count"] ?? 0;
    }
  }
  const brandRows = Array.from(brandTotals.values()).map((b) => ({
    "item.custom@brand": b.brand,
    "source_sales.net_sales": Math.round(b.netSales * 100) / 100,
    "source_sales.net_qty_sold": b.netQty,
    "source_sales.net_margin": Math.round(b.netMargin * 100) / 100,
    "source_sales.transaction_count": b.transactions,
    variantCount: b.variants.size > 1 ? b.variants.size : void 0,
    variants: b.variants.size > 1 ? Array.from(b.variants) : void 0,
    isNullBrand: b.isNullBrand || void 0
  })).sort((a, b) => (b["source_sales.net_sales"] ?? 0) - (a["source_sales.net_sales"] ?? 0));
  const returnRows = Array.from(returnAccum.values()).map((r) => ({
    "item.custom@brand": r.brand,
    "source_sales.gross_sales": Math.round(r.grossSales * 100) / 100,
    "source_sales.gross_returns": Math.round(r.grossReturns * 100) / 100,
    "source_sales.gross_qty_sold": r.grossQtySold,
    "source_sales.gross_qty_returned": r.grossQtyReturned
  })).sort((a, b) => (b["source_sales.gross_returns"] ?? 0) - (a["source_sales.gross_returns"] ?? 0));
  const repeatBuyers = Array.from(customerAccum.values()).filter((c) => c.transactions > 1);
  const totalCustomers = customerAccum.size;
  const repeatCustomers = repeatBuyers.length;
  const newCustomers = totalCustomers - repeatCustomers;
  const repeatRevenue = repeatBuyers.reduce((s, c) => s + c.netSales, 0);
  const brandSumNetSales = Array.from(brandTotals.values()).reduce((s, b) => s + b.netSales, 0);
  const totalNetSales = aggregateNetSales > 0 ? aggregateNetSales : brandSumNetSales;
  const totalTransactions = aggregateTransactions > 0 ? aggregateTransactions : Array.from(brandTotals.values()).reduce((s, b) => s + b.transactions, 0);
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
      marginAvailable: totalNetMargin !== null
    },
    brandRows,
    returnRows,
    customerInsights: {
      totalCustomers,
      repeatCustomers,
      newCustomers,
      repeatRate: totalCustomers > 0 ? Math.round(repeatCustomers / totalCustomers * 1e3) / 10 : 0,
      repeatRevenue: Math.round(repeatRevenue * 100) / 100,
      repeatRevenuePct: totalNetSales > 0 ? Math.round(repeatRevenue / totalNetSales * 1e3) / 10 : 0
    },
    cachedAt
  });
}
async function handleVendorHealth() {
  const reporting = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#REPORTING#SALES" }
    })
  );
  const brandRows = reporting.Item?.["brandRows"] ?? [];
  const merged = /* @__PURE__ */ new Map();
  for (const r of brandRows) {
    const raw = (r["item.custom@brand"] ?? "").trim();
    if (!raw) continue;
    const key = raw.toUpperCase();
    let entry = merged.get(key);
    if (!entry) {
      entry = { brand: raw, netSales: 0, units: 0 };
      merged.set(key, entry);
    }
    entry.netSales += r["source_sales.net_sales"] ?? 0;
    entry.units += r["source_sales.net_qty_sold"] ?? 0;
  }
  const topBrands = [...merged.values()].map((b) => ({
    brand: b.brand,
    netSalesYTD: Math.round(b.netSales * 100) / 100,
    unitsYTD: b.units
  })).sort((a, b) => b.netSalesYTD - a.netSalesYTD).slice(0, 10);
  const cache = await cacheStats();
  const cacheReady = cache.totalCanonical > 0;
  const enriched = await Promise.all(
    topBrands.map(async (b) => {
      let activity = null;
      if (cacheReady) {
        try {
          activity = await cacheVendorActivity(b.brand, 90);
        } catch {
        }
      }
      return {
        ...b,
        emailActivity: activity ? {
          messageCount: activity.messageCount,
          lastContactDate: activity.lastContactDate,
          topSenders: activity.topSenders.slice(0, 3),
          topSubjects: activity.topSubjects.slice(0, 3),
          recentMessageIds: activity.recentMessageIds.slice(0, 5)
        } : null
      };
    })
  );
  return json(200, {
    asOf: (/* @__PURE__ */ new Date()).toISOString(),
    cacheReady,
    cacheCoverage: cacheReady ? {
      totalMessages: cache.totalCanonical,
      oldestDate: cache.oldestDate,
      newestDate: cache.newestDate
    } : null,
    brands: enriched
  });
}
async function handlePurchaseOrderLines(event) {
  const orderId = event.pathParameters?.["id"];
  if (!orderId || !/^\d+$/.test(orderId)) {
    return json(400, { error: "Order id is required and must be numeric" });
  }
  try {
    const data = await fetchFromHeartland(`purchasing/orders/${orderId}/lines`);
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
      style_number: l.item_custom?.style_number
    }));
    return json(200, {
      orderId: parseInt(orderId, 10),
      lineCount: data.total ?? lines.length,
      lines
    });
  } catch (err) {
    console.error("Failed to fetch order lines:", err.message);
    return json(502, { error: "Failed to fetch order lines from Heartland" });
  }
}
async function handleGetVendorSettings() {
  const result = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#VENDOR#SETTINGS" }
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
      updatedAt: null
    });
  }
  return json(200, {
    activeAccounts: result.Item["activeAccounts"] ?? [],
    discontinuedVendors: result.Item["discontinuedVendors"] ?? [],
    contactedVendors: result.Item["contactedVendors"] ?? [],
    contactNotes: result.Item["contactNotes"] ?? {},
    vendorComments: result.Item["vendorComments"] ?? {},
    vendorOverrides: result.Item["vendorOverrides"] ?? {},
    customContacts: result.Item["customContacts"] ?? {},
    customVendors: result.Item["customVendors"] ?? [],
    updatedAt: result.Item["updatedAt"] ?? null
  });
}
async function handlePutVendorSettings(event) {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (body.activeAccounts !== void 0 && !Array.isArray(body.activeAccounts)) {
    return json(400, { error: "activeAccounts must be an array" });
  }
  if (body.discontinuedVendors !== void 0 && !Array.isArray(body.discontinuedVendors)) {
    return json(400, { error: "discontinuedVendors must be an array" });
  }
  if (body.contactedVendors !== void 0 && !Array.isArray(body.contactedVendors)) {
    return json(400, { error: "contactedVendors must be an array" });
  }
  const existing = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#VENDOR#SETTINGS" }
    })
  );
  const prev = existing.Item ?? {};
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await docClient2.send(
    new import_lib_dynamodb2.PutCommand({
      TableName: TABLE_NAME2,
      Item: {
        userId: OWNER_USER_ID2,
        sk: "POS#VENDOR#SETTINGS",
        activeAccounts: body.activeAccounts ?? prev["activeAccounts"] ?? [],
        discontinuedVendors: body.discontinuedVendors ?? prev["discontinuedVendors"] ?? [],
        contactedVendors: body.contactedVendors ?? prev["contactedVendors"] ?? [],
        contactNotes: body.contactNotes ?? prev["contactNotes"] ?? {},
        vendorComments: body.vendorComments ?? prev["vendorComments"] ?? {},
        vendorOverrides: body.vendorOverrides ?? prev["vendorOverrides"] ?? {},
        customContacts: body.customContacts ?? prev["customContacts"] ?? {},
        customVendors: body.customVendors ?? prev["customVendors"] ?? [],
        updatedAt
      }
    })
  );
  return json(200, { ok: true, updatedAt });
}
var ADMIN_EMAIL = process.env["ADMIN_EMAIL"] ?? "jandoossai@gmail.com";
var ADMIN_SUB = "f4682498-d0d1-70cd-c302-27ff64bb2b6e";
function getCallerEmail(event) {
  return (event.requestContext.authorizer.jwt.claims["email"] ?? "").toLowerCase();
}
function getCallerSub(event) {
  return event.requestContext.authorizer.jwt.claims["sub"] ?? "";
}
function isAdminCaller(event) {
  const email = getCallerEmail(event);
  if (email && email === ADMIN_EMAIL.toLowerCase()) return true;
  const sub = getCallerSub(event);
  if (sub && sub === ADMIN_SUB) return true;
  return false;
}
async function handleGetAdminSettings() {
  const result = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "ADMIN#SETTINGS" }
    })
  );
  return json(200, {
    visibilityOverrides: result.Item?.["visibilityOverrides"] ?? {},
    dailyTarget: result.Item?.["dailyTarget"] ?? 1500,
    updatedAt: result.Item?.["updatedAt"] ?? null
  });
}
async function handlePutAdminSettings(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Only the admin can modify admin settings" });
  }
  const updatedBy = getCallerEmail(event) || getCallerSub(event) || "admin";
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (body.visibilityOverrides && typeof body.visibilityOverrides !== "object") {
    return json(400, { error: "visibilityOverrides must be an object" });
  }
  if (body.dailyTarget !== void 0 && (typeof body.dailyTarget !== "number" || body.dailyTarget < 0)) {
    return json(400, { error: "dailyTarget must be a positive number" });
  }
  const existing = await docClient2.send(new import_lib_dynamodb2.GetCommand({
    TableName: TABLE_NAME2,
    Key: { userId: OWNER_USER_ID2, sk: "ADMIN#SETTINGS" }
  }));
  const prev = existing.Item ?? {};
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await docClient2.send(
    new import_lib_dynamodb2.PutCommand({
      TableName: TABLE_NAME2,
      Item: {
        userId: OWNER_USER_ID2,
        sk: "ADMIN#SETTINGS",
        visibilityOverrides: body.visibilityOverrides ?? prev["visibilityOverrides"] ?? {},
        dailyTarget: body.dailyTarget ?? prev["dailyTarget"] ?? 1500,
        updatedAt,
        updatedBy
      }
    })
  );
  return json(200, { ok: true, updatedAt });
}
async function handleGetEmails(event) {
  const limit = Math.min(60, parseInt(event.queryStringParameters?.["limit"] ?? "30", 10));
  const result = await docClient2.send(
    new import_lib_dynamodb2.QueryCommand({
      TableName: TABLE_NAME2,
      KeyConditionExpression: "userId = :uid AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":uid": OWNER_USER_ID2, ":prefix": "EMAIL#" },
      ScanIndexForward: false,
      // newest first
      Limit: limit
    })
  );
  const emails = (result.Items ?? []).map((item) => ({
    date: item["date"],
    subject: item["subject"],
    bodyText: item["bodyText"],
    bodyHtml: item["bodyHtml"],
    status: item["status"],
    sendStatus: item["sendStatus"],
    sendError: item["sendError"] ?? null,
    generatedAt: item["generatedAt"]
  }));
  return json(200, { emails });
}
async function handleTestEmail(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Only the admin can trigger test emails" });
  }
  const fnName = process.env["DAILY_REPORT_FUNCTION_NAME"];
  if (!fnName) return json(500, { error: "Daily report function not configured" });
  await lambdaClient.send(new import_client_lambda.InvokeCommand({
    FunctionName: fnName,
    InvocationType: "Event",
    // async
    Payload: Buffer.from(JSON.stringify({ trigger: "manual" }))
  }));
  return json(202, { ok: true, message: "Email generation queued \u2014 check the feed in 30-60 seconds." });
}
async function handleSyncStatus() {
  const status = await getSyncStatus();
  if (!status) {
    return json(200, {
      lastSyncAt: null,
      status: "never",
      message: "No sync has run yet. The first scheduled sync runs every 6 hours, or trigger one manually."
    });
  }
  return json(200, status);
}
async function handleTriggerSync() {
  if (!SYNC_FUNCTION_NAME) {
    return json(500, { error: "Sync function not configured" });
  }
  try {
    await lambdaClient.send(
      new import_client_lambda.InvokeCommand({
        FunctionName: SYNC_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ trigger: "manual" }))
      })
    );
    return json(202, {
      status: "queued",
      message: "Sync started. Check /pos/sync-status in 30-60 seconds for results."
    });
  } catch (err) {
    console.error("Failed to invoke sync:", err.message);
    return json(500, { error: "Failed to start sync" });
  }
}
var REPLY_FROM_ADDRESS = process.env["FROM_ADDRESS"] ?? "notifications@fsmanagementsystem.com";
var REPLY_TO_ADDRESS = process.env["VENDOR_REPLY_TO_ADDRESS"] ?? "flowermound@footsolutions.com";
async function handleVendorCommentReplyNotify(event) {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!body.vendorName || !body.originalComment?.text || !body.reply?.text) {
    return json(400, {
      error: "vendorName, originalComment.text, and reply.text are required"
    });
  }
  const storeName = body.storeName?.trim() || "Foot Solutions Flower Mound";
  const vendorName = body.vendorName.trim();
  const original = body.originalComment;
  const reply = body.reply;
  const jwtEmail = String(
    event.requestContext.authorizer.jwt.claims["email"] ?? ""
  );
  const author = body.authorEmail?.trim() || jwtEmail || "unknown";
  const html = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px;color:#1e293b">\u{1F4AC} New Vendor Comment Reply</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 20px">From the Foot Solutions Management System</p>

    <table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="padding:4px 0;font-weight:600;width:90px">Store:</td><td>${storeName}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Vendor:</td><td><strong style="color:#1e293b">${vendorName}</strong></td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Replied by:</td><td>${escapeHtml(author)}</td></tr>
    </table>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;margin-bottom:12px">
      <p style="margin:0 0 6px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Original comment</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap">${escapeHtml(original.text)}</p>
      ${original.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#94a3b8">${escapeHtml(original.createdAt)} CT</p>` : ""}
    </div>

    <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:6px;padding:14px;border-left:4px solid #2563eb">
      <p style="margin:0 0 6px;font-size:11px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">\u21B3 Reply</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap;color:#1e293b">${escapeHtml(reply.text)}</p>
      ${reply.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#1e40af">${escapeHtml(reply.createdAt)} CT</p>` : ""}
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
    original.createdAt ? `(${original.createdAt} CT)` : "",
    ``,
    `\u21B3 Reply:`,
    reply.text,
    reply.createdAt ? `(${reply.createdAt} CT)` : ""
  ].filter(Boolean).join("\n");
  try {
    await sesClient.send(new import_client_sesv2.SendEmailCommand({
      FromEmailAddress: `Foot Solutions <${REPLY_FROM_ADDRESS}>`,
      Destination: { ToAddresses: [REPLY_TO_ADDRESS] },
      Content: { Simple: {
        Subject: { Data: `\u{1F4AC} ${vendorName} \u2014 comment reply by ${author} (${storeName})` },
        Body: { Html: { Data: html }, Text: { Data: text } }
      } }
    }));
    return json(200, { ok: true });
  } catch (err) {
    console.error("Reply notify SES send failed:", err.message);
    return json(500, { error: `Failed to send notification: ${err.message}` });
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function handleVendorCommentAddNotify(event) {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!body.vendorName || !body.comment?.text) {
    return json(400, {
      error: "vendorName and comment.text are required"
    });
  }
  const storeName = body.storeName?.trim() || "Foot Solutions Flower Mound";
  const vendorName = body.vendorName.trim();
  const comment = body.comment;
  const jwtEmail = String(
    event.requestContext.authorizer.jwt.claims["email"] ?? ""
  );
  const author = body.authorEmail?.trim() || jwtEmail || "unknown";
  const html = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px;color:#1e293b">\u{1F4DD} New Vendor Card Comment</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 20px">From the Foot Solutions Management System</p>

    <table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse;margin-bottom:16px">
      <tr><td style="padding:4px 0;font-weight:600;width:90px">Store:</td><td>${storeName}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Vendor:</td><td><strong style="color:#1e293b">${escapeHtml(vendorName)}</strong></td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Added by:</td><td>${escapeHtml(author)}</td></tr>
    </table>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:14px;border-left:4px solid #2563eb">
      <p style="margin:0 0 6px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Comment</p>
      <p style="margin:0;font-size:14px;white-space:pre-wrap">${escapeHtml(comment.text)}</p>
      ${comment.createdAt ? `<p style="margin:8px 0 0;font-size:11px;color:#94a3b8">${escapeHtml(comment.createdAt)} CT</p>` : ""}
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
    comment.createdAt ? `(${comment.createdAt} CT)` : ""
  ].filter(Boolean).join("\n");
  try {
    await sesClient.send(new import_client_sesv2.SendEmailCommand({
      FromEmailAddress: `Foot Solutions <${REPLY_FROM_ADDRESS}>`,
      Destination: { ToAddresses: [REPLY_TO_ADDRESS] },
      Content: { Simple: {
        Subject: { Data: `\u{1F4DD} ${vendorName} \u2014 new comment by ${author} (${storeName})` },
        Body: { Html: { Data: html }, Text: { Data: text } }
      } }
    }));
    return json(200, { ok: true });
  } catch (err) {
    console.error("Comment-add notify SES send failed:", err.message);
    return json(500, { error: `Failed to send notification: ${err.message}` });
  }
}
var HEARTLAND_SYNC_FN_NAME = process.env["HEARTLAND_SYNC_FN_NAME"] ?? "foot-solutions-heartland-sync";
var CAMPAIGN_FROM_ADDRESS = process.env["CAMPAIGN_FROM_ADDRESS"] ?? "notifications@fsmanagementsystem.com";
var CAMPAIGN_REPLY_TO = process.env["CAMPAIGN_REPLY_TO"] ?? "flowermound@footsolutions.com";
var CAMPAIGN_STORE_ADDRESS = "2321 Justin Rd, Flower Mound, TX 75028";
var CAMPAIGN_STORE_NAME = "Foot Solutions Flower Mound";
var UNSUBSCRIBE_SECRET = process.env["UNSUBSCRIBE_SECRET"] ?? "fs-unsubscribe-2026-do-not-share";
function customerSk(id) {
  return `POS#CUSTOMER#${id}`;
}
async function readCustomerStats() {
  const res = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: "POS#CUSTOMER_STATS" }
    })
  );
  if (!res.Item) return null;
  const item = res.Item;
  return {
    totalCustomers: Number(item["totalCustomers"] ?? 0),
    totalReported: Number(item["totalReported"] ?? 0),
    withEmail: Number(item["withEmail"] ?? 0),
    optedIn: Number(item["optedIn"] ?? 0),
    reachableEmails: Number(item["reachableEmails"] ?? item["withEmail"] ?? 0),
    activeCount: Number(item["activeCount"] ?? 0),
    dormant6m: Number(item["dormant6m"] ?? 0),
    dormant12m: Number(item["dormant12m"] ?? 0),
    dormancyCutoff6m: item["dormancyCutoff6m"] ?? null,
    dormancyCutoff12m: item["dormancyCutoff12m"] ?? null,
    signupsByMonth: Array.isArray(item["signupsByMonth"]) ? item["signupsByMonth"] : [],
    updatedAt: item["updatedAt"] ?? null,
    recencyUpdatedAt: item["recencyUpdatedAt"] ?? null
  };
}
async function handleGetCustomers(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Customer database is admin-only" });
  }
  const qp = event.queryStringParameters ?? {};
  const q = (qp["q"] ?? "").trim().toLowerCase();
  const hasEmailFilter = qp["hasEmail"] === "true";
  const optedInFilter = qp["optedIn"] === "true";
  const reachableFilter = qp["reachable"] === "true";
  const dormancyFilter = qp["dormancy"] === "6m" ? "6m" : qp["dormancy"] === "12m" ? "12m" : null;
  const cutoff6m = (() => {
    const d = /* @__PURE__ */ new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const cutoff12m = (() => {
    const d = /* @__PURE__ */ new Date();
    d.setMonth(d.getMonth() - 12);
    return d.toISOString().slice(0, 10);
  })();
  const dormancyCutoff = dormancyFilter === "6m" ? cutoff6m : dormancyFilter === "12m" ? cutoff12m : null;
  const activeFilter = qp["active"] === "true" ? true : qp["active"] === "false" ? false : void 0;
  const limit = Math.min(Number(qp["limit"] ?? 100) || 100, 500);
  const cursor = qp["cursor"];
  const collected = [];
  let exclusiveStartKey;
  if (cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf-8")
      );
    } catch {
    }
  }
  let lastEvaluatedKey;
  let scanned = 0;
  const SCAN_LIMIT = 5e3;
  while (collected.length < limit && scanned < SCAN_LIMIT) {
    const res = await docClient2.send(
      new import_lib_dynamodb2.QueryCommand({
        TableName: TABLE_NAME2,
        KeyConditionExpression: "userId = :u AND begins_with(sk, :p)",
        ExpressionAttributeValues: {
          ":u": OWNER_USER_ID2,
          ":p": "POS#CUSTOMER#"
        },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of res.Items ?? []) {
      scanned++;
      const c = item;
      const email = String(c["email"] ?? "").trim();
      if (hasEmailFilter && !email) continue;
      if (reachableFilter) {
        if (!email) continue;
        if (c["unsubscribed"] === true) continue;
      }
      if (optedInFilter) {
        if (!email) continue;
        if (c["promotionalEmails"] !== true) continue;
        if (c["unsubscribed"] === true) continue;
      }
      if (activeFilter !== void 0 && c["active"] !== activeFilter) continue;
      if (dormancyCutoff) {
        const lastPurchase = c["lastPurchaseAt"]?.slice(0, 10);
        if (lastPurchase && lastPurchase >= dormancyCutoff) continue;
      }
      if (q) {
        const hay = `${String(c["nameLower"] ?? "")} ${String(
          c["emailLower"] ?? ""
        )} ${String(c["phoneNumber"] ?? "")}`;
        if (!hay.includes(q)) continue;
      }
      collected.push({
        customerId: Number(c["customerId"]),
        publicId: c["publicId"] ?? null,
        firstName: String(c["firstName"] ?? ""),
        lastName: String(c["lastName"] ?? ""),
        name: String(c["name"] ?? ""),
        email,
        phoneNumber: c["phoneNumber"] ?? null,
        active: c["active"] !== false,
        promotionalEmails: c["promotionalEmails"] === true,
        promotionalMessages: c["promotionalMessages"] === true,
        loyaltyBalance: Number(c["loyaltyBalance"] ?? 0),
        loyaltyTotal: Number(c["loyaltyTotal"] ?? 0),
        createdAt: c["createdAt"] ?? null,
        updatedAt: c["updatedAt"] ?? null,
        signupMonth: c["signupMonth"] ?? null,
        unsubscribed: c["unsubscribed"] === true,
        lastPurchaseAt: c["lastPurchaseAt"] ?? null
      });
      if (collected.length >= limit) break;
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
    if (!lastEvaluatedKey) break;
    exclusiveStartKey = lastEvaluatedKey;
  }
  const nextCursor = collected.length >= limit && lastEvaluatedKey ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64url") : null;
  const stats = await readCustomerStats();
  return json(200, {
    customers: collected,
    stats,
    cursor: nextCursor,
    hasMore: !!nextCursor
  });
}
async function handleGetCustomerHistory(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Customer history is admin-only" });
  }
  const customerIdRaw = event.pathParameters?.["id"];
  const customerId = Number(customerIdRaw);
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return json(400, { error: "Invalid customer id" });
  }
  const ddbItem = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: `POS#CUSTOMER#${customerId}` }
    })
  );
  const customerRow = ddbItem.Item;
  if (!customerRow) {
    return json(404, { error: "Customer not found in local cache" });
  }
  const STORE_TZ = "America/Chicago";
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmtDate.format(/* @__PURE__ */ new Date());
  const windows = [];
  for (let i = 0; i < 6; i++) {
    const end = /* @__PURE__ */ new Date();
    end.setMonth(end.getMonth() - 6 * i);
    const start = /* @__PURE__ */ new Date();
    start.setMonth(start.getMonth() - 6 * (i + 1));
    windows.push({
      from: fmtDate.format(start),
      to: i === 0 ? today : fmtDate.format(end)
    });
  }
  const allTickets = [];
  for (const win of windows) {
    const filter = JSON.stringify({
      customer_id: customerId,
      local_completed_at: {
        $gte: `${win.from}T00:00:00`,
        $lte: `${win.to}T23:59:59`
      }
    });
    const path = `sales/tickets?_filter=${encodeURIComponent(filter)}`;
    let page = 1;
    while (true) {
      let res;
      try {
        res = await fetchFromHeartland(`${path}&page=${page}`);
      } catch (err) {
        console.warn(
          `History: customer ${customerId} window ${win.from}\u2192${win.to} page ${page} failed: ${err.message}`
        );
        break;
      }
      for (const t of res.results) {
        if (t["voided?"]) continue;
        if (!t["completed?"]) continue;
        allTickets.push(t);
      }
      if (page >= (res.pages ?? 1)) break;
      page++;
      if (page > 5) break;
    }
    if (allTickets.length >= 100) break;
  }
  allTickets.sort(
    (a, b) => (b.local_completed_at ?? "").localeCompare(a.local_completed_at ?? "")
  );
  const truncated = allTickets.length > 50;
  const recentTickets = allTickets.slice(0, 50);
  const linesByTicket = /* @__PURE__ */ new Map();
  const concurrency = 10;
  for (let i = 0; i < recentTickets.length; i += concurrency) {
    const batch = recentTickets.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (t) => {
        try {
          const res = await fetchFromHeartland(
            `sales/tickets/${t.id}/lines`
          );
          linesByTicket.set(t.id, res.results ?? []);
        } catch (err) {
          console.warn(
            `History: failed to load lines for ticket ${t.id}: ${err.message}`
          );
          linesByTicket.set(t.id, []);
        }
      })
    );
  }
  const tickets = recentTickets.map((t) => {
    const lines = linesByTicket.get(t.id) ?? [];
    const productLines = lines.filter(
      (l) => l.type === "ItemLine" || l.type === "ReturnLine"
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
        description: l.description || "(unknown item)",
        brand: l.item_custom?.brand ?? null,
        department: l.item_custom?.department ?? l.item_custom?.class ?? null,
        qty: l.qty,
        unitPrice: l.adjusted_unit_price,
        originalPrice: l.original_unit_price,
        total: l.value,
        isReturn: l.type === "ReturnLine" || l.qty < 0
      }))
    };
  });
  const totalSpend = tickets.reduce((sum, t) => sum + (t.total ?? 0), 0);
  const ticketCount = tickets.length;
  return json(200, {
    customer: {
      id: customerId,
      name: customerRow["name"] || [customerRow["firstName"], customerRow["lastName"]].filter(Boolean).join(" ").trim() || "(no name)",
      email: customerRow["email"] ?? null,
      phoneNumber: customerRow["phoneNumber"] ?? null,
      lastPurchaseAt: customerRow["lastPurchaseAt"] ?? null,
      totalSpend,
      ticketCount
    },
    tickets,
    truncated
  });
}
async function handleTriggerCustomersSync(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Customer sync is admin-only" });
  }
  try {
    await lambdaClient.send(
      new import_client_lambda.InvokeCommand({
        FunctionName: HEARTLAND_SYNC_FN_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({ trigger: "customers-only" })
        )
      })
    );
    return json(202, {
      status: "triggered",
      message: "Customer sync started in the background. Refresh the page in 30-60s to see updated counts."
    });
  } catch (err) {
    console.error("Customer sync trigger failed:", err.message);
    return json(500, { error: "Failed to trigger sync" });
  }
}
async function handleCampaignSend(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Campaign send is admin-only" });
  }
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const subject = (body.subject ?? "").trim();
  const htmlBody = (body.htmlBody ?? "").trim();
  if (!subject || !htmlBody) {
    return json(400, { error: "subject and htmlBody are required" });
  }
  const optInMode = body.optInMode === "permissive" ? "permissive" : "strict";
  const waveSize = body.waveSize && body.waveSize > 0 ? Math.min(body.waveSize, 5e3) : null;
  const waveCursor = body.waveCursor && body.waveCursor > 0 ? body.waveCursor : 0;
  function passesGate(c) {
    if (c["unsubscribed"] === true) return false;
    if (optInMode === "strict" && c["promotionalEmails"] !== true) return false;
    return true;
  }
  let recipients = [];
  let nextWaveCursor = null;
  if (body.testEmail) {
    const e = body.testEmail.trim();
    if (!e || !e.includes("@")) {
      return json(400, { error: "testEmail must be a valid address" });
    }
    recipients.push({ id: 0, email: e, name: "Test recipient" });
  } else if (body.recipients === "selected") {
    const ids = Array.isArray(body.selectedIds) ? body.selectedIds : [];
    if (ids.length === 0) {
      return json(400, { error: "selectedIds is required when recipients=selected" });
    }
    if (ids.length > 5e3) {
      return json(400, { error: "Maximum 5000 recipients per send" });
    }
    for (const id of ids) {
      try {
        const res = await docClient2.send(
          new import_lib_dynamodb2.GetCommand({
            TableName: TABLE_NAME2,
            Key: { userId: OWNER_USER_ID2, sk: customerSk(id) }
          })
        );
        if (!res.Item) continue;
        const c = res.Item;
        const email = String(c["email"] ?? "").trim();
        if (!email) continue;
        if (!passesGate(c)) continue;
        recipients.push({
          id: Number(c["customerId"]),
          email,
          name: String(c["name"] ?? "")
        });
      } catch {
      }
    }
  } else if (body.recipients === "all") {
    const collected = [];
    let exclusiveStartKey;
    while (true) {
      const res = await docClient2.send(
        new import_lib_dynamodb2.QueryCommand({
          TableName: TABLE_NAME2,
          KeyConditionExpression: "userId = :u AND begins_with(sk, :p)",
          ExpressionAttributeValues: {
            ":u": OWNER_USER_ID2,
            ":p": "POS#CUSTOMER#"
          },
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      for (const item of res.Items ?? []) {
        const c = item;
        const email = String(c["email"] ?? "").trim();
        if (!email) continue;
        if (!passesGate(c)) continue;
        collected.push({
          id: Number(c["customerId"]),
          email,
          name: String(c["name"] ?? "")
        });
      }
      if (!res.LastEvaluatedKey) break;
      exclusiveStartKey = res.LastEvaluatedKey;
      if (collected.length >= 2e4) break;
    }
    collected.sort((a, b) => a.id - b.id);
    if (waveSize) {
      const startIdx = collected.findIndex((r) => r.id > waveCursor);
      const window = startIdx === -1 ? [] : collected.slice(startIdx, startIdx + waveSize);
      recipients = window;
      const last = window[window.length - 1];
      if (last && startIdx !== -1 && startIdx + waveSize < collected.length) {
        nextWaveCursor = last.id;
      }
    } else {
      recipients = collected;
    }
  } else {
    return json(400, {
      error: 'recipients must be "all" or "selected" (or pass testEmail)'
    });
  }
  if (recipients.length === 0) {
    const reason = optInMode === "strict" ? "No eligible recipients (need promotionalEmails=true and unsubscribed=false)" : "No eligible recipients (need email and unsubscribed=false)";
    return json(400, { error: reason });
  }
  const sendResults = { sent: 0, failed: 0, errors: [] };
  const startedAt = Date.now();
  for (const r of recipients) {
    const unsubToken = signUnsubscribeToken(r.id, r.email);
    const unsubUrl = `${getSelfBaseUrl(event)}/campaign/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
    const fullHtml = wrapCampaignHtml({
      bodyHtml: htmlBody,
      recipientName: r.name,
      unsubUrl
    });
    const fullText = wrapCampaignText({
      bodyText: body.textBody ?? stripHtmlForText(htmlBody),
      unsubUrl
    });
    try {
      await sesClient.send(
        new import_client_sesv2.SendEmailCommand({
          FromEmailAddress: `Foot Solutions Flower Mound <${CAMPAIGN_FROM_ADDRESS}>`,
          ReplyToAddresses: [CAMPAIGN_REPLY_TO],
          Destination: { ToAddresses: [r.email] },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: {
                Html: { Data: fullHtml },
                Text: { Data: fullText }
              },
              Headers: [
                {
                  Name: "List-Unsubscribe",
                  Value: `<${unsubUrl}>`
                },
                {
                  Name: "List-Unsubscribe-Post",
                  Value: "List-Unsubscribe=One-Click"
                }
              ]
            }
          }
        })
      );
      sendResults.sent++;
    } catch (err) {
      sendResults.failed++;
      const msg = err.message;
      if (sendResults.errors.length < 5) sendResults.errors.push(msg);
      console.error(`Campaign send to ${r.email} failed:`, msg);
    }
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
    hasMoreWaves: nextWaveCursor != null
  });
}
async function handleCampaignUnsubscribe(event) {
  const token = event.queryStringParameters?.["token"] ?? "";
  const verified = verifyUnsubscribeToken(token);
  const html = (heading, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foot Solutions \u2014 Unsubscribe</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:48px 16px;text-align:center}.card{background:#fff;max-width:480px;margin:0 auto;padding:32px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{margin:0 0 12px;font-size:20px}p{color:#475569;line-height:1.5}.foot{margin-top:24px;font-size:12px;color:#94a3b8}</style></head><body><div class="card"><h1>${heading}</h1><p>${body}</p><p class="foot">${CAMPAIGN_STORE_NAME} \xB7 ${CAMPAIGN_STORE_ADDRESS}</p></div></body></html>`;
  if (!verified) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html(
        "Invalid unsubscribe link",
        "This link is malformed or has expired. If you'd like to stop receiving emails from us, reply to any of our messages with the word UNSUBSCRIBE and we'll remove you manually."
      )
    };
  }
  try {
    await docClient2.send(
      new import_lib_dynamodb2.UpdateCommand({
        TableName: TABLE_NAME2,
        Key: { userId: OWNER_USER_ID2, sk: customerSk(verified.id) },
        UpdateExpression: "SET unsubscribed = :t, unsubscribedAt = :now",
        ExpressionAttributeValues: {
          ":t": true,
          ":now": (/* @__PURE__ */ new Date()).toISOString()
        }
      })
    );
  } catch (err) {
    console.error("Unsubscribe write failed:", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html(
        "Something went wrong",
        "We couldn't update your subscription right now. Please reply to one of our emails and we'll remove you manually."
      )
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html(
      "You've been unsubscribed",
      `${verified.email} has been removed from our promotional email list. We're sorry to see you go \u2014 feel free to drop by ${CAMPAIGN_STORE_NAME} anytime.`
    )
  };
}
function getSelfBaseUrl(event) {
  const host = event.headers?.["host"] ?? event.headers?.["Host"] ?? "";
  const proto = event.headers?.["x-forwarded-proto"] ?? event.headers?.["X-Forwarded-Proto"] ?? "https";
  return host ? `${proto}://${host}` : "";
}
function signUnsubscribeToken(id, email) {
  const payload = `${id}.${email}`;
  const sig = crypto3.createHmac("sha256", UNSUBSCRIBE_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}
function verifyUnsubscribeToken(token) {
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    return null;
  }
  const expected = crypto3.createHmac("sha256", UNSUBSCRIBE_SECRET).update(payload).digest("base64url");
  if (expected !== sig) return null;
  const [idStr, email] = payload.split(".");
  if (!idStr || !email) return null;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id < 0) return null;
  return { id, email };
}
function wrapCampaignHtml({
  bodyHtml,
  recipientName,
  unsubUrl
}) {
  const firstName = recipientName ? recipientName.trim().split(/\s+/)[0] ?? "" : "";
  const friendlyFirst = firstName.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  const greeting = friendlyFirst ? `<p style="margin:0 0 16px">Hi ${escapeHtml(friendlyFirst)},</p>` : '<p style="margin:0 0 16px">Hi there,</p>';
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
      <p style="margin:8px 0 0">${CAMPAIGN_STORE_NAME} \xB7 ${CAMPAIGN_STORE_ADDRESS}</p>
      <p style="margin:8px 0 0">You're receiving this email because you opted in at our store. <a href="${unsubUrl}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
function wrapCampaignText({
  bodyText,
  unsubUrl
}) {
  return [
    bodyText,
    "",
    "---",
    `${CAMPAIGN_STORE_NAME}`,
    `${CAMPAIGN_STORE_ADDRESS}`,
    `Reply to: ${CAMPAIGN_REPLY_TO}`,
    `Unsubscribe: ${unsubUrl}`
  ].join("\n");
}
function stripHtmlForText(html) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<\/?(p|div|br|h[1-6]|li)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
var COST_CACHE_SK = "COSTS#LATEST";
var COST_CACHE_TTL_MS = 12 * 60 * 60 * 1e3;
var COST_PROJECT_TAG = "foot-solutions-platform";
async function getCachedCosts() {
  const r = await docClient2.send(
    new import_lib_dynamodb2.GetCommand({
      TableName: TABLE_NAME2,
      Key: { userId: OWNER_USER_ID2, sk: COST_CACHE_SK }
    })
  );
  return r.Item ?? null;
}
async function saveCachedCosts(summary) {
  await docClient2.send(
    new import_lib_dynamodb2.PutCommand({
      TableName: TABLE_NAME2,
      Item: { userId: OWNER_USER_ID2, sk: COST_CACHE_SK, ...summary }
    })
  );
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
async function fetchAwsCosts() {
  const now = /* @__PURE__ */ new Date();
  const monthStart = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600 * 1e3));
  const thirtyDaysAgo = ymd(new Date(now.getTime() - 30 * 24 * 3600 * 1e3));
  const tagFilter = {
    Tags: { Key: "Project", Values: [COST_PROJECT_TAG] }
  };
  let filteredByTag = true;
  let mtdTotal = 0;
  let last30Total = 0;
  let byService = [];
  let currency = "USD";
  let notes;
  try {
    const mtdResp = await ceClient.send(
      new import_client_cost_explorer.GetCostAndUsageCommand({
        TimePeriod: { Start: monthStart, End: tomorrow },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: tagFilter
      })
    );
    const groups = mtdResp.ResultsByTime?.[0]?.Groups ?? [];
    for (const g of groups) {
      const service = g.Keys?.[0] ?? "Unknown";
      const amount = g.Metrics?.["UnblendedCost"]?.Amount;
      const unit = g.Metrics?.["UnblendedCost"]?.Unit;
      if (unit) currency = unit;
      const cost = amount ? parseFloat(amount) : 0;
      mtdTotal += cost;
      if (cost > 0) byService.push({ service, cost });
    }
    byService.sort((a, b) => b.cost - a.cost);
    const last30Resp = await ceClient.send(
      new import_client_cost_explorer.GetCostAndUsageCommand({
        TimePeriod: { Start: thirtyDaysAgo, End: tomorrow },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: tagFilter
      })
    );
    for (const r of last30Resp.ResultsByTime ?? []) {
      const amt = r.Total?.["UnblendedCost"]?.Amount;
      if (amt) last30Total += parseFloat(amt);
    }
    if (mtdTotal === 0 && last30Total === 0 && byService.length === 0) {
      filteredByTag = false;
      notes = 'Project tag not yet activated for cost allocation. Showing total account costs. Activate the "Project" tag in AWS Billing Console \u2192 Cost Allocation Tags to scope to this app only.';
      const fallbackMtd = await ceClient.send(
        new import_client_cost_explorer.GetCostAndUsageCommand({
          TimePeriod: { Start: monthStart, End: tomorrow },
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }]
        })
      );
      for (const g of fallbackMtd.ResultsByTime?.[0]?.Groups ?? []) {
        const service = g.Keys?.[0] ?? "Unknown";
        const amount = g.Metrics?.["UnblendedCost"]?.Amount;
        const unit = g.Metrics?.["UnblendedCost"]?.Unit;
        if (unit) currency = unit;
        const cost = amount ? parseFloat(amount) : 0;
        mtdTotal += cost;
        if (cost > 0) byService.push({ service, cost });
      }
      byService.sort((a, b) => b.cost - a.cost);
      const fallback30 = await ceClient.send(
        new import_client_cost_explorer.GetCostAndUsageCommand({
          TimePeriod: { Start: thirtyDaysAgo, End: tomorrow },
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"]
        })
      );
      for (const r of fallback30.ResultsByTime ?? []) {
        const amt = r.Total?.["UnblendedCost"]?.Amount;
        if (amt) last30Total += parseFloat(amt);
      }
    }
  } catch (err) {
    console.error("Cost Explorer call failed:", err.message);
    throw err;
  }
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    monthToDateTotal: Math.round(mtdTotal * 100) / 100,
    last30DaysTotal: Math.round(last30Total * 100) / 100,
    currency,
    monthStart,
    monthEnd: tomorrow,
    byService: byService.map((s) => ({ ...s, cost: Math.round(s.cost * 100) / 100 })),
    filteredByTag,
    notes
  };
}
async function handleAwsCosts(event) {
  if (!isAdminCaller(event)) {
    return json(403, { error: "Cost data is admin-only" });
  }
  const refresh = event.queryStringParameters?.["refresh"] === "true";
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
    return json(500, { error: `Failed to fetch costs: ${err.message}` });
  }
}
var handler = async (event) => {
  switch (event.routeKey) {
    case "GET /pos/dashboard":
      return handleDashboard(event);
    case "GET /pos/sales":
      return handleSalesByYear(event);
    case "GET /pos/import-tax-defaults":
      return handleImportTaxDefaults(event);
    case "GET /pos/analytics":
      return handleAnalytics(event);
    case "GET /pos/inventory":
      return handleInventory();
    case "GET /pos/staff":
      return handleStaff(event);
    case "GET /pos/purchasing":
      return handlePurchasing();
    case "GET /pos/vendor-health":
      return handleVendorHealth();
    case "GET /pos/purchasing/orders/{id}/lines":
      return handlePurchaseOrderLines(event);
    case "GET /pos/reporting":
      return handleReporting(event);
    case "GET /pos/insights":
      return handleInsights(event);
    case "GET /pos/sync-status":
      return handleSyncStatus();
    case "POST /pos/sync":
      return handleTriggerSync();
    case "GET /pos/vendor-settings":
      return handleGetVendorSettings();
    case "PUT /pos/vendor-settings":
      return handlePutVendorSettings(event);
    case "POST /pos/vendor-comment-reply":
      return handleVendorCommentReplyNotify(event);
    case "POST /pos/vendor-comment-add":
      return handleVendorCommentAddNotify(event);
    case "GET /pos/customers":
      return handleGetCustomers(event);
    case "GET /pos/customers/{id}/history":
      return handleGetCustomerHistory(event);
    case "POST /pos/customers/sync":
      return handleTriggerCustomersSync(event);
    case "POST /campaign/send":
      return handleCampaignSend(event);
    case "GET /campaign/unsubscribe":
      return handleCampaignUnsubscribe(event);
    case "GET /admin/aws-costs":
      return handleAwsCosts(event);
    case "GET /admin/settings":
      return handleGetAdminSettings();
    case "PUT /admin/settings":
      return handlePutAdminSettings(event);
    case "GET /admin/emails":
      return handleGetEmails(event);
    case "POST /admin/test-email":
      return handleTestEmail(event);
    default:
      return json(404, { error: "Route not found" });
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
