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

// lambda/heartland-sync/index.ts
var heartland_sync_exports = {};
__export(heartland_sync_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(heartland_sync_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");
var dynamoClient = new import_client_dynamodb.DynamoDBClient({ region: "us-east-1" });
var docClient = import_lib_dynamodb.DynamoDBDocumentClient.from(dynamoClient);
var TABLE_NAME = process.env["TABLE_NAME"];
var OWNER_USER_ID = process.env["OWNER_USER_ID"];
var FLOWER_MOUND_LOCATION_ID = 100006;
var EXTENSION_BASE_URL = "http://localhost:2773";
async function getHeartlandSecret() {
  const url = `${EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent("foot-solutions/heartland/api-token")}`;
  const res = await fetch(url, {
    headers: { "X-Aws-Parameters-Secrets-Token": process.env["AWS_SESSION_TOKEN"] ?? "" }
  });
  if (!res.ok) throw new Error(`Failed to load Heartland secret: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.SecretString);
}
async function fetchPage(secret, path, page, perPage = 200) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${secret.baseUrl}/${path}${sep}per_page=${perPage}&page=${page}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret.token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Heartland ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}
async function syncPaymentsAndTickets(secret) {
  const STORE_TZ = "America/Chicago";
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmtDate.format(/* @__PURE__ */ new Date());
  const windowStart = /* @__PURE__ */ new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - 35);
  const fromDate = fmtDate.format(windowStart);
  const paymentFilter = JSON.stringify({
    local_completed_at: {
      $gte: `${fromDate}T00:00:00`,
      $lte: `${today}T23:59:59`
    },
    status: "complete"
  });
  const paymentPath = `payments?sort=local_completed_at&_filter=${encodeURIComponent(paymentFilter)}`;
  const firstPage = await fetchPage(secret, paymentPath, 1);
  const totalPages = Math.ceil(firstPage.total / 200);
  const payments = [...firstPage.results];
  for (let p = 2; p <= totalPages; p++) {
    const data = await fetchPage(secret, paymentPath, p);
    payments.push(...data.results);
  }
  const ticketFilter = JSON.stringify({
    local_completed_at: {
      $gte: `${fromDate}T00:00:00`,
      $lte: `${today}T23:59:59`
    }
  });
  const ticketPath = `sales/tickets?_filter=${encodeURIComponent(ticketFilter)}`;
  const firstTPage = await fetchPage(secret, ticketPath, 1);
  const totalTPages = Math.ceil(firstTPage.total / 200);
  const tickets = [...firstTPage.results];
  for (let p = 2; p <= totalTPages; p++) {
    const data = await fetchPage(secret, ticketPath, p);
    tickets.push(...data.results);
  }
  const rollups = /* @__PURE__ */ new Map();
  for (const p of payments) {
    if (p.status !== "complete") continue;
    const ts = p.local_completed_at ?? p.completed_at;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    let bucket = rollups.get(date);
    if (!bucket) {
      bucket = {
        date,
        count: 0,
        totalAmount: 0,
        totalDiscounts: 0,
        byPaymentType: {},
        byHour: {},
        topCustomers: {},
        bySalesRep: {},
        taxBySalesRep: {}
      };
      rollups.set(date, bucket);
    }
    bucket.count += 1;
    bucket.totalAmount += p.amount;
    const typeKey = String(p.payment_type_id);
    if (!bucket.byPaymentType[typeKey]) bucket.byPaymentType[typeKey] = { count: 0, amount: 0 };
    bucket.byPaymentType[typeKey].count += 1;
    bucket.byPaymentType[typeKey].amount += p.amount;
    const hour = ts.slice(11, 13);
    bucket.byHour[hour] = (bucket.byHour[hour] ?? 0) + p.amount;
  }
  for (const t of tickets) {
    if (!t["completed?"] || t["voided?"]) continue;
    const ts = t.local_completed_at ?? t.completed_at;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    const bucket = rollups.get(date);
    if (!bucket) continue;
    bucket.totalDiscounts += t.total_discounts ?? 0;
    if (t.customer_name) {
      bucket.topCustomers[t.customer_name] = (bucket.topCustomers[t.customer_name] ?? 0) + t.total;
    }
    const rep = t.sales_rep?.trim() || "Unassigned";
    bucket.bySalesRep[rep] = (bucket.bySalesRep[rep] ?? 0) + t.total;
    bucket.taxBySalesRep[rep] = (bucket.taxBySalesRep[rep] ?? 0) + (t.total_tax ?? 0);
  }
  const writes = [];
  for (const rollup of rollups.values()) {
    writes.push(
      docClient.send(new import_lib_dynamodb.PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: OWNER_USER_ID,
          sk: `POS#DAILY#${rollup.date}`,
          date: rollup.date,
          rollup,
          cachedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      }))
    );
  }
  await Promise.all(writes);
  return {
    daysWritten: rollups.size,
    paymentsScanned: payments.length,
    ticketsScanned: tickets.length
  };
}
async function syncInventory(secret) {
  const allValues = [];
  let page = 1;
  const maxPages = 100;
  while (page <= maxPages) {
    const path = `inventory/values?group[]=item_id&group[]=location_id&exclude_empty_locations=true&~[location_id]=${FLOWER_MOUND_LOCATION_ID}`;
    const data2 = await fetchPage(secret, path, page);
    if (!data2.results || data2.results.length === 0) break;
    allValues.push(...data2.results);
    if (page >= (data2.pages ?? 1)) break;
    page++;
  }
  const itemIds = [...new Set(allValues.map((v) => v.item_id).filter(Boolean))];
  const itemDetails = /* @__PURE__ */ new Map();
  let itemPage = 1;
  const maxItemPages = 400;
  while (itemPage <= maxItemPages) {
    const data2 = await fetchPage(secret, "items?~[active]=true", itemPage);
    if (!data2.results || data2.results.length === 0) break;
    for (const item of data2.results) {
      itemDetails.set(item.id, {
        description: item.description ?? "",
        cost: item.cost ?? 0,
        price: item.price ?? 0,
        public_id: item.public_id ?? "",
        brand: item.custom?.brand ?? "",
        department: item.custom?.department ?? ""
      });
    }
    if (itemPage >= (data2.pages ?? 1)) break;
    itemPage++;
  }
  const stockItems = allValues.filter((v) => v.qty_on_hand > 0).map((v) => {
    const detail = itemDetails.get(v.item_id);
    const cost = detail?.cost ?? v.unit_cost ?? 0;
    const price = detail?.price ?? 0;
    const margin = price > 0 && cost > 0 ? Math.round((price - cost) / price * 1e3) / 10 : null;
    return {
      item_id: v.item_id,
      sku: detail?.public_id ?? "",
      description: detail?.description ?? "",
      brand: detail?.brand ?? "",
      department: detail?.department ?? "",
      cost,
      price,
      margin,
      qty_on_hand: v.qty_on_hand,
      qty_available: v.qty_available,
      qty_committed: v.qty_committed,
      qty_on_po: v.qty_on_po,
      unit_cost: v.unit_cost
    };
  });
  const byDepartment = {};
  const byBrand = {};
  let totalQtyOnHand = 0;
  for (const item of stockItems) {
    totalQtyOnHand += item.qty_on_hand;
    const dept = item.department || "Uncategorized";
    const brand = item.brand || "Unknown";
    if (!byDepartment[dept]) byDepartment[dept] = { count: 0, totalCost: 0, totalPrice: 0, avgMargin: 0, totalQty: 0 };
    byDepartment[dept].count += 1;
    byDepartment[dept].totalCost += item.cost;
    byDepartment[dept].totalPrice += item.price;
    byDepartment[dept].totalQty += item.qty_on_hand;
    if (!byBrand[brand]) byBrand[brand] = { count: 0, totalQty: 0 };
    byBrand[brand].count += 1;
    byBrand[brand].totalQty += item.qty_on_hand;
  }
  for (const dept of Object.values(byDepartment)) {
    dept.avgMargin = dept.totalPrice > 0 ? Math.round((dept.totalPrice - dept.totalCost) / dept.totalPrice * 1e3) / 10 : 0;
  }
  const withMargin = stockItems.filter((i) => i.margin !== null);
  const overallAvgMargin = withMargin.length > 0 ? Math.round(withMargin.reduce((s, i) => s + (i.margin ?? 0), 0) / withMargin.length * 10) / 10 : 0;
  const lowStockItems = stockItems.filter((i) => i.qty_on_hand > 0 && i.qty_on_hand <= 3).sort((a, b) => {
    if (a.qty_on_hand !== b.qty_on_hand) return a.qty_on_hand - b.qty_on_hand;
    return (a.brand ?? "").localeCompare(b.brand ?? "");
  }).slice(0, 300);
  const lowMarginItems = stockItems.filter((i) => i.margin !== null && i.margin < 20 && i.price > 0).sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0)).slice(0, 30);
  const topMarginItems = stockItems.filter((i) => i.margin !== null && i.price > 0).sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0)).slice(0, 50);
  const data = {
    locationId: FLOWER_MOUND_LOCATION_ID,
    summary: {
      totalItems: stockItems.length,
      activeItems: stockItems.length,
      liveItems: stockItems.length,
      itemsWithCostData: withMargin.length,
      overallAvgMarginPct: overallAvgMargin,
      totalQtyOnHand
    },
    byDepartment: Object.entries(byDepartment).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    byBrand: Object.entries(byBrand).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count).slice(0, 30),
    topMarginItems,
    lowMarginItems,
    lowStockItems
  };
  await docClient.send(new import_lib_dynamodb.PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: "POS#INVENTORY#CATALOG",
      data,
      cachedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  }));
  return { totalItems: stockItems.length, totalQtyOnHand };
}
async function syncPurchasing(secret) {
  const vendors = [];
  let page = 1;
  while (page <= 10) {
    const data = await fetchPage(secret, "purchasing/vendors", page);
    if (!data.results || data.results.length === 0) break;
    vendors.push(...data.results);
    if (page >= (data.pages ?? 1)) break;
    page++;
  }
  await docClient.send(new import_lib_dynamodb.PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: "POS#PURCHASING#VENDORS",
      vendors,
      cachedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  }));
  const firstOPage = await fetchPage(secret, "purchasing/orders", 1);
  const totalOPages = Math.ceil(firstOPage.total / 200);
  const startOPage = Math.max(1, totalOPages - 5);
  const orders = [];
  for (let p = totalOPages; p >= startOPage; p--) {
    const data = await fetchPage(secret, "purchasing/orders", p);
    orders.push(...data.results);
  }
  const vendorMap = {};
  for (const v of vendors) {
    if (v.name) vendorMap[v.id] = v.name;
  }
  const enrichedOrders = orders.map((o) => ({
    ...o,
    vendorName: o.vendor_id ? vendorMap[o.vendor_id] ?? `Vendor ${o.vendor_id}` : "Unknown"
  }));
  const allOrders = [...orders];
  for (let p = Math.max(1, startOPage - 1); p >= 1; p--) {
    const data = await fetchPage(secret, "purchasing/orders", p);
    allOrders.push(...data.results);
  }
  const vendorReceivedQty = {};
  const vendorOpenOrders = {};
  const vendorTotalOrders = {};
  for (const o of allOrders) {
    if (!o.vendor_id) continue;
    vendorReceivedQty[o.vendor_id] = (vendorReceivedQty[o.vendor_id] ?? 0) + (o.total_received_qty ?? 0);
    vendorTotalOrders[o.vendor_id] = (vendorTotalOrders[o.vendor_id] ?? 0) + 1;
    if (o.status === "open" || o.status === "pending") {
      vendorOpenOrders[o.vendor_id] = (vendorOpenOrders[o.vendor_id] ?? 0) + 1;
    }
  }
  const vendorRank = vendors.map((v) => ({
    vendorId: v.id,
    vendorName: v.name ?? `Vendor ${v.id}`,
    totalReceivedQty: vendorReceivedQty[v.id] ?? 0,
    openOrders: vendorOpenOrders[v.id] ?? 0,
    totalOrders: vendorTotalOrders[v.id] ?? 0
  })).sort((a, b) => b.totalReceivedQty - a.totalReceivedQty).map((v, i) => ({ ...v, rank: i + 1 }));
  const openOrders = allOrders.filter((o) => o.status === "open" || o.status === "pending").map((o) => ({
    ...o,
    vendorName: o.vendor_id ? vendorMap[o.vendor_id] ?? `Vendor ${o.vendor_id}` : "Unknown"
  })).slice(0, 500);
  await Promise.all([
    docClient.send(new import_lib_dynamodb.PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: "POS#PURCHASING#VENDORS",
        vendors,
        vendorRank,
        cachedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    })),
    docClient.send(new import_lib_dynamodb.PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: "POS#PURCHASING#ORDERS",
        orders: openOrders,
        totalOrders: firstOPage.total,
        cachedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    }))
  ]);
  return { vendorCount: vendors.length, orderCount: openOrders.length };
}
async function syncReporting(secret) {
  const STORE_TZ = "America/Chicago";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmt.format(/* @__PURE__ */ new Date());
  const thirtyDaysAgoDate = /* @__PURE__ */ new Date();
  thirtyDaysAgoDate.setUTCDate(thirtyDaysAgoDate.getUTCDate() - 30);
  const thirtyDaysAgo = fmt.format(thirtyDaysAgoDate);
  const currentYear = parseInt(today.slice(0, 4), 10);
  const yearStart = `${currentYear}-01-01`;
  const datePath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.date&start_date=${thirtyDaysAgo}&end_date=${today}`;
  const monthPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.month_of_year&groups[]=date.year&start_date=${yearStart}&end_date=${today}`;
  const brandPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.net_qty_sold&metrics[]=source_sales.transaction_count&groups[]=item.custom@brand&start_date=${yearStart}&end_date=${today}`;
  const totalsPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.year&start_date=${yearStart}&end_date=${today}`;
  const returnPath = `reporting/analyzer?metrics[]=source_sales.gross_sales&metrics[]=source_sales.gross_returns&metrics[]=source_sales.gross_qty_sold&metrics[]=source_sales.gross_qty_returned&groups[]=item.custom@brand&start_date=${yearStart}&end_date=${today}`;
  const customerPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=customer.public_id&start_date=${yearStart}&end_date=${today}`;
  let dateRows = [];
  let monthRows = [];
  let brandRows = [];
  let returnRows = [];
  let customerRows = [];
  let totalsRows = [];
  const fetchReport = async (path, label) => {
    try {
      const data = await fetchPage(secret, path, 1, 500);
      return data.results ?? [];
    } catch (err) {
      console.warn(`Reporting ${label} sync failed (non-fatal):`, err.message);
      return [];
    }
  };
  [dateRows, monthRows, brandRows, returnRows, customerRows, totalsRows] = await Promise.all([
    fetchReport(datePath, "date"),
    fetchReport(monthPath, "monthly"),
    fetchReport(brandPath, "brand"),
    fetchReport(returnPath, "returns"),
    fetchReport(customerPath, "customers"),
    fetchReport(totalsPath, "totals")
  ]);
  await docClient.send(new import_lib_dynamodb.PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId: OWNER_USER_ID,
      sk: "POS#REPORTING#SALES",
      rows: dateRows,
      monthRows,
      brandRows,
      returnRows,
      customerRows,
      totalsRows,
      fromDate: thirtyDaysAgo,
      toDate: today,
      yearStart,
      cachedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  }));
  const yearsToCache = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear];
  for (const yr of yearsToCache) {
    const yStart = `${yr}-01-01`;
    const yEnd = yr === currentYear ? today : `${yr}-12-31`;
    const yBrandPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.net_qty_sold&metrics[]=source_sales.transaction_count&groups[]=item.custom@brand&start_date=${yStart}&end_date=${yEnd}`;
    const yReturnPath = `reporting/analyzer?metrics[]=source_sales.gross_sales&metrics[]=source_sales.gross_returns&metrics[]=source_sales.gross_qty_sold&metrics[]=source_sales.gross_qty_returned&groups[]=item.custom@brand&start_date=${yStart}&end_date=${yEnd}`;
    const yCustomerPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=customer.public_id&start_date=${yStart}&end_date=${yEnd}`;
    const yTotalsPath = `reporting/analyzer?metrics[]=source_sales.net_sales&metrics[]=source_sales.transaction_count&groups[]=date.year&start_date=${yStart}&end_date=${yEnd}`;
    const [yBrand, yReturn, yCustomer, yTotals] = await Promise.all([
      fetchReport(yBrandPath, `brand-${yr}`),
      fetchReport(yReturnPath, `return-${yr}`),
      fetchReport(yCustomerPath, `customer-${yr}`),
      fetchReport(yTotalsPath, `totals-${yr}`)
    ]);
    if (yBrand.length === 0 && yReturn.length === 0 && yCustomer.length === 0 && yTotals.length === 0) continue;
    try {
      await docClient.send(new import_lib_dynamodb.PutCommand({
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
          cachedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      }));
    } catch (err) {
      console.warn(`Year ${yr} cache write failed (non-fatal):`, err.message);
    }
  }
  return { rows: dateRows.length, monthRows: monthRows.length, brandRows: brandRows.length, returnRows: returnRows.length, customerRows: customerRows.length };
}
async function syncStaffAndPaymentTypes(secret) {
  const [usersRes, ptRes] = await Promise.all([
    fetch(`${secret.baseUrl}/users?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } }),
    fetch(`${secret.baseUrl}/payment_types?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } })
  ]);
  const users = usersRes.ok ? (await usersRes.json()).results ?? [] : [];
  const types = ptRes.ok ? (await ptRes.json()).results ?? [] : [];
  await Promise.all([
    docClient.send(new import_lib_dynamodb.PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: "POS#USERS#LIST", users, cachedAt: (/* @__PURE__ */ new Date()).toISOString() }
    })),
    docClient.send(new import_lib_dynamodb.PutCommand({
      TableName: TABLE_NAME,
      Item: { userId: OWNER_USER_ID, sk: "POS#PAYMENT_TYPES#LIST", types, cachedAt: (/* @__PURE__ */ new Date()).toISOString() }
    }))
  ]);
  return { userCount: users.length, paymentTypeCount: types.length };
}
async function writeSyncStatus(status) {
  await docClient.send(new import_lib_dynamodb.PutCommand({
    TableName: TABLE_NAME,
    Item: { userId: OWNER_USER_ID, sk: "POS#SYNC#STATUS", ...status, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }
  }));
}
async function syncCustomers(secret) {
  const perPage = 200;
  let page = 1;
  let pagesPulled = 0;
  let customersWritten = 0;
  let withEmail = 0;
  let optedIn = 0;
  let reachableEmails = 0;
  let activeCount = 0;
  let totalReported = 0;
  const signupsByMonth = /* @__PURE__ */ new Map();
  while (true) {
    const res = await fetchPage(
      secret,
      "customers",
      page,
      perPage
    );
    pagesPulled++;
    if (page === 1) totalReported = res.total ?? 0;
    const items = res.results.map((c) => {
      const email = (c.email ?? "").trim();
      if (email) withEmail++;
      const optedInStrict = email && c["promotional_emails?"] === true;
      if (optedInStrict) optedIn++;
      if (email) reachableEmails++;
      if (c["active?"]) activeCount++;
      if (c.created_at) {
        const month = c.created_at.slice(0, 7);
        signupsByMonth.set(month, (signupsByMonth.get(month) ?? 0) + 1);
      }
      const firstName = (c.first_name ?? "").trim();
      const lastName = (c.last_name ?? "").trim();
      const fullName = c.name?.trim() || [firstName, lastName].filter(Boolean).join(" ").trim() || "(no name)";
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
        email,
        emailLower: email.toLowerCase(),
        phoneNumber: c.phone_number ?? null,
        active: c["active?"] ?? true,
        promotionalEmails: email && c["promotional_emails?"] !== false ? true : false,
        promotionalMessages: c["promotional_messages?"] === true,
        loyaltyBalance: c.loyalty_points_balance ?? 0,
        loyaltyTotal: c.loyalty_points_total ?? 0,
        createdAt: c.created_at ?? null,
        updatedAt: c.updated_at ?? null,
        deletedAt: c.deleted_at ?? null,
        signupMonth: c.created_at?.slice(0, 7) ?? null,
        // Unsubscribe state — flipped by GET /campaign/unsubscribe. Kept
        // separate from `promotionalEmails` so we can distinguish "vendor
        // says no" from "customer hit our unsubscribe link" when needed.
        unsubscribed: false
      };
    });
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      try {
        await Promise.all(
          batch.map(
            (item) => docClient.send(new import_lib_dynamodb.PutCommand({ TableName: TABLE_NAME, Item: item }))
          )
        );
        customersWritten += batch.length;
      } catch (err) {
        console.error("customer batch write failed:", err.message);
      }
    }
    if (page >= (res.pages ?? 1)) break;
    page++;
    if (page > 200) break;
  }
  const monthEntries = [...signupsByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-24);
  await docClient.send(
    new import_lib_dynamodb.PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: OWNER_USER_ID,
        sk: "POS#CUSTOMER_STATS",
        totalCustomers: customersWritten,
        totalReported,
        withEmail,
        optedIn,
        reachableEmails,
        activeCount,
        signupsByMonth: monthEntries.map(([month, count]) => ({ month, count })),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    })
  );
  return {
    customersWritten,
    pagesPulled,
    totalReported,
    withEmail,
    optedIn,
    reachableEmails
  };
}
async function syncCustomerRecency(secret) {
  const STORE_TZ = "America/Chicago";
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = fmtDate.format(/* @__PURE__ */ new Date());
  const lastByCustomer = /* @__PURE__ */ new Map();
  let ticketsScanned = 0;
  const windows = [];
  for (let i = 0; i < 8; i++) {
    const end = /* @__PURE__ */ new Date();
    end.setMonth(end.getMonth() - 3 * i);
    const start = /* @__PURE__ */ new Date();
    start.setMonth(start.getMonth() - 3 * (i + 1));
    windows.push({
      from: fmtDate.format(start),
      to: i === 0 ? today : fmtDate.format(end)
    });
  }
  for (const win of windows) {
    const filter = JSON.stringify({
      local_completed_at: {
        $gte: `${win.from}T00:00:00`,
        $lte: `${win.to}T23:59:59`
      }
    });
    const ticketPath = `sales/tickets?_filter=${encodeURIComponent(filter)}`;
    let page = 1;
    while (true) {
      let res;
      try {
        res = await fetchPage(secret, ticketPath, page, 200);
      } catch (err) {
        console.warn(
          `Recency sync: window ${win.from}\u2192${win.to} page ${page} failed: ${err.message}`
        );
        break;
      }
      for (const t of res.results) {
        if (t["voided?"]) continue;
        if (!t["completed?"]) continue;
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
      if (page > 200) break;
    }
    console.log(
      `Recency window ${win.from}\u2192${win.to}: scanned ${ticketsScanned} so far, ${lastByCustomer.size} distinct customers`
    );
  }
  let customersStamped = 0;
  const ids = [...lastByCustomer.entries()];
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    await Promise.all(
      batch.map(async ([cid, date]) => {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: TABLE_NAME,
              Key: { userId: OWNER_USER_ID, sk: `POS#CUSTOMER#${cid}` },
              UpdateExpression: "SET lastPurchaseAt = :d, lastPurchaseStampedAt = :now",
              ExpressionAttributeValues: {
                ":d": date,
                ":now": (/* @__PURE__ */ new Date()).toISOString()
              },
              // Don't fail if the customer row doesn't exist — could
              // happen if the customer sync is stale.
              ConditionExpression: "attribute_exists(sk)"
            })
          );
          customersStamped++;
        } catch (err) {
          const e = err;
          if (e.name !== "ConditionalCheckFailedException") {
            console.warn(
              `recency stamp failed for ${cid}:`,
              err.message
            );
          }
        }
      })
    );
  }
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
  let dormant6m = 0;
  let dormant12m = 0;
  let exclusiveStartKey;
  while (true) {
    const res = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :u AND begins_with(sk, :p)",
        ExpressionAttributeValues: {
          ":u": OWNER_USER_ID,
          ":p": "POS#CUSTOMER#"
        },
        ProjectionExpression: "lastPurchaseAt, email",
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of res.Items ?? []) {
      const last = item["lastPurchaseAt"];
      const email = String(item["email"] ?? "").trim();
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
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: "POS#CUSTOMER_STATS" },
      UpdateExpression: "SET dormant6m = :d6, dormant12m = :d12, dormancyCutoff6m = :c6, dormancyCutoff12m = :c12, recencyUpdatedAt = :now",
      ExpressionAttributeValues: {
        ":d6": dormant6m,
        ":d12": dormant12m,
        ":c6": cutoff6m,
        ":c12": cutoff12m,
        ":now": (/* @__PURE__ */ new Date()).toISOString()
      }
    })
  );
  return { ticketsScanned, customersStamped, dormant6m, dormant12m };
}
var handler = async (event) => {
  const start = Date.now();
  const trigger = "source" in (event ?? {}) && event.source === "aws.events" ? "schedule" : event?.trigger || "manual";
  const todayOnly = trigger === "today-only";
  const customersOnly = trigger === "customers-only";
  console.log(
    `Sync start: trigger=${trigger} todayOnly=${todayOnly} locationId=${FLOWER_MOUND_LOCATION_ID}`
  );
  const summary = {
    trigger,
    todayOnly,
    startedAt: new Date(start).toISOString(),
    locationId: FLOWER_MOUND_LOCATION_ID
  };
  let secret;
  try {
    secret = await getHeartlandSecret();
  } catch (err) {
    summary["error"] = `Secret load: ${err.message}`;
    await writeSyncStatus({ ...summary, status: "error", durationMs: Date.now() - start });
    return summary;
  }
  const sections = todayOnly ? [["payments", () => syncPaymentsAndTickets(secret)]] : customersOnly ? [
    ["customers", () => syncCustomers(secret)],
    ["customerRecency", () => syncCustomerRecency(secret)]
  ] : [
    ["payments", () => syncPaymentsAndTickets(secret)],
    ["inventory", () => syncInventory(secret)],
    ["purchasing", () => syncPurchasing(secret)],
    ["reporting", () => syncReporting(secret)],
    ["staff", () => syncStaffAndPaymentTypes(secret)],
    ["customers", () => syncCustomers(secret)],
    ["customerRecency", () => syncCustomerRecency(secret)]
  ];
  for (const [name, fn] of sections) {
    try {
      const t0 = Date.now();
      const result = await fn();
      summary[name] = { ...result, durationMs: Date.now() - t0 };
    } catch (err) {
      console.error(`Sync section ${name} failed:`, err.message);
      summary[name] = { error: err.message };
    }
  }
  const durationMs = Date.now() - start;
  summary["durationMs"] = durationMs;
  summary["completedAt"] = (/* @__PURE__ */ new Date()).toISOString();
  const anyError = sections.some(([name]) => {
    const s = summary[name];
    return s && typeof s === "object" && "error" in s && s.error;
  });
  const allError = sections.every(([name]) => {
    const s = summary[name];
    return s && typeof s === "object" && "error" in s && s.error;
  });
  summary["status"] = allError ? "error" : anyError ? "partial" : "ok";
  await writeSyncStatus(summary);
  console.log(`Sync complete in ${durationMs}ms:`, JSON.stringify(summary));
  return summary;
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
