"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: 'us-east-1' });
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
const TABLE_NAME = process.env['TABLE_NAME'];
const OWNER_USER_ID = process.env['OWNER_USER_ID'];
// Flower Mound location ID confirmed from /api/locations
const FLOWER_MOUND_LOCATION_ID = 100006;
const EXTENSION_BASE_URL = 'http://localhost:2773';
// ── Helpers ──────────────────────────────────────────────────────────
async function getHeartlandSecret() {
    const url = `${EXTENSION_BASE_URL}/secretsmanager/get?secretId=${encodeURIComponent('foot-solutions/heartland/api-token')}`;
    const res = await fetch(url, {
        headers: { 'X-Aws-Parameters-Secrets-Token': process.env['AWS_SESSION_TOKEN'] ?? '' },
    });
    if (!res.ok)
        throw new Error(`Failed to load Heartland secret: ${res.status}`);
    const data = (await res.json());
    return JSON.parse(data.SecretString);
}
async function fetchPage(secret, path, page, perPage = 200) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${secret.baseUrl}/${path}${sep}per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret.token}` } });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Heartland ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json());
}
// ── Sync: Payments + Tickets (daily rollups) ─────────────────────────
async function syncPaymentsAndTickets(secret) {
    // Payments — fetch last 30 pages (newest data)
    const firstPage = await fetchPage(secret, 'payments?sort=completed_at', 1);
    const totalPages = Math.ceil(firstPage.total / 200);
    const startPage = Math.max(1, totalPages - 30);
    const payments = [];
    for (let p = totalPages; p >= startPage; p--) {
        const data = await fetchPage(secret, 'payments?sort=completed_at', p);
        payments.push(...data.results);
    }
    // Tickets — fetch last 25 pages for enrichment (discounts, customers, reps)
    const firstTPage = await fetchPage(secret, 'sales/tickets', 1);
    const totalTPages = Math.ceil(firstTPage.total / 200);
    const startTPage = Math.max(1, totalTPages - 25);
    const tickets = [];
    for (let p = totalTPages; p >= startTPage; p--) {
        const data = await fetchPage(secret, 'sales/tickets', p);
        tickets.push(...data.results);
    }
    // Build rollups from payments
    const rollups = new Map();
    for (const p of payments) {
        if (p.status !== 'complete')
            continue;
        const ts = p.local_completed_at ?? p.completed_at;
        if (!ts)
            continue;
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
        if (!bucket.byPaymentType[typeKey])
            bucket.byPaymentType[typeKey] = { count: 0, amount: 0 };
        bucket.byPaymentType[typeKey].count += 1;
        bucket.byPaymentType[typeKey].amount += p.amount;
        const hour = ts.slice(11, 13);
        bucket.byHour[hour] = (bucket.byHour[hour] ?? 0) + p.amount;
    }
    // Enrich with ticket data
    for (const t of tickets) {
        if (!t['completed?'] || t['voided?'])
            continue;
        const ts = t.local_completed_at ?? t.completed_at;
        if (!ts)
            continue;
        const date = ts.slice(0, 10);
        const bucket = rollups.get(date);
        if (!bucket)
            continue;
        bucket.totalDiscounts += t.total_discounts ?? 0;
        if (t.customer_name) {
            bucket.topCustomers[t.customer_name] = (bucket.topCustomers[t.customer_name] ?? 0) + t.total;
        }
        const rep = t.sales_rep?.trim() || 'Unassigned';
        bucket.bySalesRep[rep] = (bucket.bySalesRep[rep] ?? 0) + t.total;
    }
    // Write to DynamoDB
    const writes = [];
    for (const rollup of rollups.values()) {
        writes.push(docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: {
                userId: OWNER_USER_ID,
                sk: `POS#DAILY#${rollup.date}`,
                date: rollup.date,
                rollup,
                cachedAt: new Date().toISOString(),
            },
        })));
    }
    await Promise.all(writes);
    return {
        daysWritten: rollups.size,
        paymentsScanned: payments.length,
        ticketsScanned: tickets.length,
    };
}
// ── Sync: Inventory (per-location stock from /inventory/values) ──────
async function syncInventory(secret) {
    // Fetch all items with stock at Flower Mound (location 100006)
    // Using the correct path: /inventory/values?group[]=item_id&group[]=location_id
    // with exclude_empty_locations=true to skip zero-stock items
    const allValues = [];
    let page = 1;
    const maxPages = 100; // 5,987 items / 200 per page = ~30 pages
    while (page <= maxPages) {
        const path = `inventory/values?group[]=item_id&group[]=location_id&exclude_empty_locations=true&~[location_id]=${FLOWER_MOUND_LOCATION_ID}`;
        const data = await fetchPage(secret, path, page);
        if (!data.results || data.results.length === 0)
            break;
        allValues.push(...data.results);
        if (page >= (data.pages ?? 1))
            break;
        page++;
    }
    // Also fetch item details for the items we have in stock
    // We'll embed cost/price from the items endpoint for margin analysis
    // Fetch items in batches using the item_ids we found
    const itemIds = [...new Set(allValues.map((v) => v.item_id).filter(Boolean))];
    // Fetch item details for cost/price/description (batch by filtering)
    // We'll fetch all active items and join — more reliable than per-item calls
    const itemDetails = new Map();
    // Fetch items in pages, only active ones
    let itemPage = 1;
    const maxItemPages = 400;
    while (itemPage <= maxItemPages) {
        const data = await fetchPage(secret, 'items?~[active]=true', itemPage);
        if (!data.results || data.results.length === 0)
            break;
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
        if (itemPage >= (data.pages ?? 1))
            break;
        itemPage++;
    }
    // Build enriched inventory records
    const stockItems = allValues
        .filter((v) => v.qty_on_hand > 0)
        .map((v) => {
        const detail = itemDetails.get(v.item_id);
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
    const byDepartment = {};
    const byBrand = {};
    let totalQtyOnHand = 0;
    for (const item of stockItems) {
        totalQtyOnHand += item.qty_on_hand;
        const dept = item.department || 'Uncategorized';
        const brand = item.brand || 'Unknown';
        if (!byDepartment[dept])
            byDepartment[dept] = { count: 0, totalCost: 0, totalPrice: 0, avgMargin: 0, totalQty: 0 };
        byDepartment[dept].count += 1;
        byDepartment[dept].totalCost += item.cost;
        byDepartment[dept].totalPrice += item.price;
        byDepartment[dept].totalQty += item.qty_on_hand;
        if (!byBrand[brand])
            byBrand[brand] = { count: 0, totalQty: 0 };
        byBrand[brand].count += 1;
        byBrand[brand].totalQty += item.qty_on_hand;
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
        .sort((a, b) => a.qty_on_hand - b.qty_on_hand)
        .slice(0, 50);
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
    await docClient.send(new lib_dynamodb_1.PutCommand({
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
async function syncPurchasing(secret) {
    // Vendors
    const vendors = [];
    let page = 1;
    while (page <= 10) {
        const data = await fetchPage(secret, 'purchasing/vendors', page);
        if (!data.results || data.results.length === 0)
            break;
        vendors.push(...data.results);
        if (page >= (data.pages ?? 1))
            break;
        page++;
    }
    await docClient.send(new lib_dynamodb_1.PutCommand({
        TableName: TABLE_NAME,
        Item: {
            userId: OWNER_USER_ID,
            sk: 'POS#PURCHASING#VENDORS',
            vendors,
            cachedAt: new Date().toISOString(),
        },
    }));
    // Recent purchase orders (last 5 pages = ~1,000 most recent)
    const firstOPage = await fetchPage(secret, 'purchasing/orders', 1);
    const totalOPages = Math.ceil(firstOPage.total / 200);
    const startOPage = Math.max(1, totalOPages - 5);
    const orders = [];
    for (let p = totalOPages; p >= startOPage; p--) {
        const data = await fetchPage(secret, 'purchasing/orders', p);
        orders.push(...data.results);
    }
    // Build vendor name map for display
    const vendorMap = {};
    for (const v of vendors) {
        if (v.name)
            vendorMap[v.id] = v.name;
    }
    const enrichedOrders = orders.map((o) => ({
        ...o,
        vendorName: o.vendor_id ? (vendorMap[o.vendor_id] ?? `Vendor ${o.vendor_id}`) : 'Unknown',
    }));
    // Compute vendor sales rank from ALL orders (total received qty = proxy for sales volume).
    // Fetch all order pages for the ranking calculation.
    const allOrders = [...orders];
    for (let p = Math.max(1, startOPage - 1); p >= 1; p--) {
        const data = await fetchPage(secret, 'purchasing/orders', p);
        allOrders.push(...data.results);
    }
    const vendorReceivedQty = {};
    const vendorOpenOrders = {};
    const vendorTotalOrders = {};
    for (const o of allOrders) {
        if (!o.vendor_id)
            continue;
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
    // Only store open/pending orders to stay under DynamoDB 400KB item limit
    const openOrders = enrichedOrders
        .filter((o) => o.status === 'open' || o.status === 'pending')
        .slice(0, 200);
    // Store vendors + rank in one item, open orders in another (keeps each under 400KB)
    await Promise.all([
        docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: {
                userId: OWNER_USER_ID,
                sk: 'POS#PURCHASING#VENDORS',
                vendors,
                vendorRank,
                cachedAt: new Date().toISOString(),
            },
        })),
        docClient.send(new lib_dynamodb_1.PutCommand({
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
async function syncReporting(secret) {
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
        }
        catch (err) {
            console.warn(`Reporting ${label} sync failed (non-fatal):`, err.message);
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
    await docClient.send(new lib_dynamodb_1.PutCommand({
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
        if (yBrand.length === 0 && yReturn.length === 0 && yCustomer.length === 0 && yTotals.length === 0)
            continue;
        try {
            await docClient.send(new lib_dynamodb_1.PutCommand({
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
        }
        catch (err) {
            console.warn(`Year ${yr} cache write failed (non-fatal):`, err.message);
        }
    }
    return { rows: dateRows.length, monthRows: monthRows.length, brandRows: brandRows.length, returnRows: returnRows.length, customerRows: customerRows.length };
}
// ── Sync: Staff + Payment types ──────────────────────────────────────
async function syncStaffAndPaymentTypes(secret) {
    const [usersRes, ptRes] = await Promise.all([
        fetch(`${secret.baseUrl}/users?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } }),
        fetch(`${secret.baseUrl}/payment_types?per_page=100`, { headers: { Authorization: `Bearer ${secret.token}` } }),
    ]);
    const users = usersRes.ok
        ? (await usersRes.json()).results ?? []
        : [];
    const types = ptRes.ok
        ? (await ptRes.json()).results ?? []
        : [];
    await Promise.all([
        docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: { userId: OWNER_USER_ID, sk: 'POS#USERS#LIST', users, cachedAt: new Date().toISOString() },
        })),
        docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: { userId: OWNER_USER_ID, sk: 'POS#PAYMENT_TYPES#LIST', types, cachedAt: new Date().toISOString() },
        })),
    ]);
    return { userCount: users.length, paymentTypeCount: types.length };
}
async function writeSyncStatus(status) {
    await docClient.send(new lib_dynamodb_1.PutCommand({
        TableName: TABLE_NAME,
        Item: { userId: OWNER_USER_ID, sk: 'POS#SYNC#STATUS', ...status, updatedAt: new Date().toISOString() },
    }));
}
// ── Main handler ─────────────────────────────────────────────────────
const handler = async (event) => {
    const start = Date.now();
    const trigger = 'source' in (event ?? {}) && event.source === 'aws.events'
        ? 'schedule'
        : event?.trigger || 'manual';
    console.log(`Sync start: trigger=${trigger} locationId=${FLOWER_MOUND_LOCATION_ID}`);
    const summary = {
        trigger,
        startedAt: new Date(start).toISOString(),
        locationId: FLOWER_MOUND_LOCATION_ID,
    };
    let secret;
    try {
        secret = await getHeartlandSecret();
    }
    catch (err) {
        summary['error'] = `Secret load: ${err.message}`;
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
    ]) {
        try {
            const t0 = Date.now();
            const result = await fn();
            summary[name] = { ...result, durationMs: Date.now() - t0 };
        }
        catch (err) {
            console.error(`Sync section ${name} failed:`, err.message);
            summary[name] = { error: err.message };
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
exports.handler = handler;
//# sourceMappingURL=index.js.map