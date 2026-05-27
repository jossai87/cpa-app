/**
 * Strands tool wrappers for the Sales_Agent.
 *
 * One Strands `tool({...})` per extracted Sales tool function in
 * `lambda/chat/tools/`. The callbacks DO NOT duplicate the SQL/DDB logic —
 * they delegate to the existing imported function and let it return the
 * same JSON-string shape the legacy `/pos/chat` Lambda emits. The Strands
 * SDK auto-converts the returned string into a `toolResultBlock`.
 *
 * Tool names, descriptions, and input schemas are lifted verbatim from
 * the `TOOLS` array in `lambda/chat/index.ts` so the agent's prompt-time
 * behaviour is identical.
 *
 * Admin gating (Requirement 6.3 / Property 4) lives inside the gated
 * callback itself — `getOrthoticsCommissionTool`. The check happens
 * BEFORE the underlying DDB query, so a non-admin caller never causes
 * a DDB read.
 *
 * Tasks: 6.1 (build the wrappers), 6.2 (mount them in salesAgent.ts).
 */

import * as strands from '@strands-agents/sdk';
import * as salesTools from '../../../../../lambda/chat/tools/index.js';
import type { AttachmentRef } from '../../../../../lambda/chat/helpers.js';
import { buildToolContext, readInvocationState } from '../../lib/context.js';

/**
 * Annotate cache/live tool results with a per-row "must cite as (msg X)"
 * hint so the model surfaces the message id inline in its reply. Same
 * approach as the Inbox sub-agent — see comments in
 * ../inbox/index.ts. Without this, Haiku 4.5 sometimes refuses to cite
 * (telling the user to "search Gmail manually") which breaks the
 * frontend's clickable-link rendering.
 */
function annotateForCitation(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(annotateForCitation);
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj['id'] === 'string') {
      return { ...obj, _cite_as: `(msg ${obj['id']})` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === 'recentMessageIds' &&
        Array.isArray(v) &&
        v.every((x) => typeof x === 'string')
      ) {
        out[k] = (v as string[]).map((id) => ({
          id,
          _cite_as: `(msg ${id})`,
        }));
      } else {
        out[k] = annotateForCitation(v);
      }
    }
    return out;
  }
  return payload;
}

const ADMIN_REFUSAL = JSON.stringify({
  error: "That information isn't available to your account.",
});

// ── 1. call_inbox_assistant — DEPRECATED in the unified assistant.
//
// In the legacy /pos/chat flow this jumped to the Gmail cache. In the new
// architecture, the orchestrator handles cross-domain routing, so the
// Sales_Agent does NOT need this tool — keeping it would re-introduce the
// agents-calling-agents cycle the orchestrator was designed to replace.
// We intentionally drop this tool from the Sales_Agent tool list.

// ── 2. get_vendor_contacts ───────────────────────────────────────────
const getVendorContactsTool = strands.tool({
  name: 'get_vendor_contacts',
  description:
    "Look up contact information for one or more vendors from the store's vendor directory. Returns phone, email, website, rep name, rep phone, rep email, and account number. ALWAYS call this first when asked about vendor contact info, account numbers, or rep details — before searching Gmail. Can look up a specific vendor by name, or return all vendors.",
  inputSchema: {
    type: 'object',
    properties: {
      vendor_name: {
        type: 'string',
        description:
          'Vendor name to look up (e.g. "Brooks", "Yaleet", "SHU-RE-NU"). Leave empty to return all vendors.',
      },
    },
  },
  callback: async (input) => {
    return salesTools.getVendorContacts(input as { vendor_name?: string });
  },
});

// ── 3. get_sales_summary ─────────────────────────────────────────────
const getSalesSummaryTool = strands.tool({
  name: 'get_sales_summary',
  description:
    'Get sales revenue, ticket count, discounts, and avg ticket for a date range. Use this for questions about revenue, sales totals, daily/weekly/monthly performance, or comparisons.',
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD (Central Time)' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD (Central Time)' },
    },
    required: ['from_date', 'to_date'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getSalesSummary(
      input as { from_date?: string; to_date?: string },
      ctx
    );
  },
});

// ── 4. get_returns_data ──────────────────────────────────────────────
const getReturnsDataTool = strands.tool({
  name: 'get_returns_data',
  description:
    'Get return rates and gross return amounts by brand for the current year. Use this for any questions about returns, refunds, or return rates.',
  inputSchema: {
    type: 'object',
    properties: {
      year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getReturnsData(input as { year?: string }, ctx);
  },
});

// ── 5. get_inventory ─────────────────────────────────────────────────
const getInventoryTool = strands.tool({
  name: 'get_inventory',
  description:
    'Get inventory summary, department breakdown, top/low margin items, and low-stock items (≤3 units). Use for questions about stock levels, margins, departments, or specific items.',
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['summary', 'low_stock', 'top_margin', 'low_margin', 'by_department', 'all'],
        description: 'Which section of inventory data to return',
      },
    },
    required: ['section'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getInventory(input as { section: salesTools.InventorySection }, ctx);
  },
});

// ── 6. get_staff_performance ─────────────────────────────────────────
const getStaffPerformanceTool = strands.tool({
  name: 'get_staff_performance',
  description:
    'Get sales by staff member (sales rep) for a date range. Use for questions about who sold the most, staff rankings, or individual rep performance.',
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
    },
    required: ['from_date', 'to_date'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getStaffPerformance(
      input as { from_date?: string; to_date?: string },
      ctx
    );
  },
});

// ── 7. get_brand_performance ─────────────────────────────────────────
const getBrandPerformanceTool = strands.tool({
  name: 'get_brand_performance',
  description:
    'Get net sales, units sold, and transaction count by brand for the current year. Use for questions about which brands are selling best, brand comparisons, or brand-level revenue.',
  inputSchema: {
    type: 'object',
    properties: {
      year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
      top_n: { type: 'number', description: 'Return only the top N brands by net sales (default 20)' },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getBrandPerformance(
      input as { year?: string; top_n?: number },
      ctx
    );
  },
});

// ── 8. get_purchasing ────────────────────────────────────────────────
const getPurchasingTool = strands.tool({
  name: 'get_purchasing',
  description:
    'Get vendor list, open purchase orders, and vendor rankings by PO volume. Use for questions about vendors, purchase orders, open orders, or supplier relationships.',
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['vendors', 'open_orders', 'vendor_rank', 'all'],
        description: 'Which section of purchasing data to return',
      },
    },
    required: ['section'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getPurchasing(input as { section: salesTools.PurchasingSection }, ctx);
  },
});

// ── 9. get_customer_insights ─────────────────────────────────────────
const getCustomerInsightsTool = strands.tool({
  name: 'get_customer_insights',
  description:
    'Get customer retention metrics: total customers, repeat vs new, repeat revenue. Use for questions about customer loyalty, repeat buyers, or customer counts.',
  inputSchema: {
    type: 'object',
    properties: {
      year: { type: 'string', description: 'Year as YYYY, or "current" for the current year' },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getCustomerInsights(input as { year?: string }, ctx);
  },
});

// ── 10. get_payment_methods ──────────────────────────────────────────
const getPaymentMethodsTool = strands.tool({
  name: 'get_payment_methods',
  description: 'Get breakdown of sales by payment type (cash, credit, etc.) for a date range.',
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
    },
    required: ['from_date', 'to_date'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getPaymentMethods(
      input as { from_date?: string; to_date?: string },
      ctx
    );
  },
});

// ── 11. get_sync_status ──────────────────────────────────────────────
const getSyncStatusTool = strands.tool({
  name: 'get_sync_status',
  description:
    'Get the last time data was synced from Heartland POS, and the status of each sync section.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getSyncStatus(input as Record<string, never>, ctx);
  },
});

// ── 12. get_hourly_heatmap ───────────────────────────────────────────
const getHourlyHeatmapTool = strands.tool({
  name: 'get_hourly_heatmap',
  description:
    'Get revenue by hour of day aggregated across a date range. Use for questions about peak hours, busiest times, staffing patterns, or "when do we sell the most". Returns total and average revenue per hour (0-23 in Central Time).',
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
      day_of_week: {
        type: 'string',
        description:
          'Optional: filter to a specific day name (Monday, Tuesday, ..., Saturday, Sunday)',
      },
    },
    required: ['from_date', 'to_date'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getHourlyHeatmap(
      input as { from_date?: string; to_date?: string; day_of_week?: string },
      ctx
    );
  },
});

// ── 13. get_top_customers ────────────────────────────────────────────
const getTopCustomersTool = strands.tool({
  name: 'get_top_customers',
  description:
    'Get the top customers by revenue for a date range. Use for questions about best customers, loyalty, or who spends the most. Returns name, total revenue, and visit count.',
  inputSchema: {
    type: 'object',
    properties: {
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
      top_n: { type: 'number', description: 'Number of top customers to return (default 15, max 50)' },
    },
    required: ['from_date', 'to_date'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getTopCustomers(
      input as { from_date?: string; to_date?: string; top_n?: number },
      ctx
    );
  },
});

// ── 14. get_open_orders_detail ───────────────────────────────────────
const getOpenOrdersDetailTool = strands.tool({
  name: 'get_open_orders_detail',
  description:
    "Get open/pending purchase orders with aging analysis. Can filter by vendor name. Use for questions about outstanding orders, what's on order, how long orders have been open, or total committed spend per vendor.",
  inputSchema: {
    type: 'object',
    properties: {
      vendor_name: { type: 'string', description: 'Optional: filter to a specific vendor name (partial match)' },
      min_days_open: { type: 'number', description: 'Optional: only return orders open at least this many days' },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getOpenOrdersDetail(
      input as { vendor_name?: string; min_days_open?: number },
      ctx
    );
  },
});

// ── 15. get_historical_comparison ────────────────────────────────────
const getHistoricalComparisonTool = strands.tool({
  name: 'get_historical_comparison',
  description:
    'Compare sales performance across different years or periods. Use for year-over-year questions like "how does this year compare to last year" or "what were sales in 2024 vs 2025". Returns brand-level net sales and transaction counts per year.',
  inputSchema: {
    type: 'object',
    properties: {
      years: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Array of years to compare, e.g. ["2024", "2025", "2026"]. Defaults to current + prior year.',
      },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getHistoricalComparison(input as { years?: string[] }, ctx);
  },
});

// ── 16. get_orthotics_commission ─ ADMIN-GATED ──────────────────────
//
// Property 4 (Admin-gated tools refuse for non-admin) — Task 6.3:
// The admin check fires BEFORE any DDB query. When `isAdmin === false`
// the underlying `salesTools.getOrthoticsCommission` is never called.
const getOrthoticsCommissionTool = strands.tool({
  name: 'get_orthotics_commission',
  description:
    "Get orthotics unit sales and commission breakdown by sales rep. Commission rules: $10/unit for units 1-10, $15/unit for unit 11+. Use for questions about Becky's commission, orthotics sales by rep, or commission owed.",
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['today', '7d', '30d', 'monthly', 'ytd'],
        description: 'Time period (default: ytd)',
      },
    },
  },
  callback: async (input, context) => {
    const state = readInvocationState(context);
    if (!state.isAdmin) {
      return ADMIN_REFUSAL;
    }
    const ctx = buildToolContext(state);
    return salesTools.getOrthoticsCommission(
      input as { period?: 'today' | '7d' | '30d' | 'monthly' | 'ytd' },
      ctx
    );
  },
});

// ── 17. get_tax_summary ──────────────────────────────────────────────
const getTaxSummaryTool = strands.tool({
  name: 'get_tax_summary',
  description:
    'Get the most recent CPA tax analysis session — form inputs (revenue, expenses, COGS, payroll, etc.) and AI-estimated results (federal tax, quarterly payments, key deductions). Use for questions about the tax form, what was entered, or estimated tax liability.',
  inputSchema: {
    type: 'object',
    properties: {
      tax_year: {
        type: 'string',
        description: 'Optional: specific tax year (e.g. "2025"). Defaults to most recent session.',
      },
    },
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.getTaxSummary(input as { tax_year?: string }, ctx);
  },
});

// ── 18. cache_query — Sales_Agent retains read access to the inbox cache
// for the cross-domain bridges that survived (e.g. "did this brand email
// us about returns"). Inbox_Agent is the primary owner; Sales_Agent's
// access is read-only metadata.
const cacheQueryTool = strands.tool({
  name: 'cache_query',
  description:
    'Search the local Gmail cache (rolling ~6 month copy of the inbox). Use to find emails about a vendor brand, customer inquiries, invoices, or specific senders. Combine vendor + since/until + kind for narrow results. Returns metadata; call cache_read for body.',
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Vendor brand (Brooks, Dansko, Aetrex, Hoka, etc.)' },
      kind: { type: 'string', enum: ['invoice', 'vendor', 'customer', 'internal'] },
      since: { type: 'string', description: 'YYYY-MM-DD inclusive' },
      until: { type: 'string', description: 'YYYY-MM-DD inclusive' },
      from: { type: 'string', description: 'From-header substring' },
      text: { type: 'string', description: 'Subject/snippet substring' },
      threadId: { type: 'string' },
      limit: { type: 'number', description: 'Default 25, max 100' },
    },
  },
  callback: async (input) => {
    const out = await salesTools.cacheQuery(input as Record<string, unknown>);
    // The underlying tool returns a JSON-stringified payload — re-parse,
    // annotate, and re-stringify so the model sees `_cite_as` hints on
    // each message row.
    try {
      const parsed = JSON.parse(out);
      return JSON.stringify(annotateForCitation(parsed));
    } catch {
      return out;
    }
  },
});

// ── 19. cache_vendor_activity ────────────────────────────────────────
const cacheVendorActivityTool = strands.tool({
  name: 'cache_vendor_activity',
  description:
    "Get a vendor's email activity rollup over the last N days: message count, last contact date, top senders, top subjects, recent message IDs. Returned messages come pre-annotated with `_cite_as` — copy those tokens VERBATIM into your final reply.",
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      days: { type: 'number', description: 'Default 90, max 365' },
    },
    required: ['vendor'],
  },
  callback: async (input) => {
    const out = await salesTools.cacheVendorActivity(input as { vendor?: string; days?: number });
    try {
      const parsed = JSON.parse(out);
      return JSON.stringify(annotateForCitation(parsed));
    } catch {
      return out;
    }
  },
});

// ── 20. cache_read ───────────────────────────────────────────────────
//
// Pushes attachment metadata into `invocationState.attachments` (the
// per-turn AttachmentRef[] collector) so the Inbox_Agent's reply can
// surface it back to the orchestrator and on to the edge Lambda.
const cacheReadTool = strands.tool({
  name: 'cache_read',
  description:
    'Read full body of a cached email by id (and dateOnly for speed). The response includes an `attachments` array — mention filenames to the user when present.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      dateOnly: { type: 'string' },
    },
    required: ['id'],
  },
  callback: async (input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    // The Sales side is read-only; we still build the context so any
    // attachment surfaced flows back through the same collector.
    const out = await salesTools.cacheRead(input as { id?: string; dateOnly?: string }, ctx);
    try {
      const parsed = JSON.parse(out);
      return JSON.stringify(annotateForCitation(parsed));
    } catch {
      return out;
    }
  },
});

// ── 21. refresh_sales_now ────────────────────────────────────────────
//
// On-demand Heartland sync for today's payments+tickets only. Should be
// called BEFORE get_sales_summary whenever the user asks about "today",
// "now", "currently", or the current day's sales — anything that
// requires real-time data fresher than the scheduled 6-hour sync.
const refreshSalesNowTool = strands.tool({
  name: 'refresh_sales_now',
  description:
    "Trigger a real-time Heartland API sync for today's payments and tickets BEFORE answering questions about today's / current / right-now sales numbers. Takes 3-8 seconds. After this completes, call get_sales_summary with today's date to see the freshest data. Use this whenever the user asks about today, this morning, current, now, right now, or any question implying real-time accuracy. Do NOT call for historical questions (yesterday, last week, etc) — those are already cached.",
  inputSchema: {
    type: 'object',
    properties: {},
  },
  callback: async (_input, context) => {
    const ctx = buildToolContext(readInvocationState(context));
    return salesTools.refreshSalesNow({}, ctx);
  },
});

/**
 * Final tool list — 17 POS tools + 3 read-only inbox bridges.
 * The legacy `call_inbox_assistant` tool is intentionally dropped:
 * cross-domain routing is now the orchestrator's job, not a sub-agent's.
 */
export const SALES_TOOLS = [
  getVendorContactsTool,
  getSalesSummaryTool,
  getReturnsDataTool,
  getInventoryTool,
  getStaffPerformanceTool,
  getBrandPerformanceTool,
  getPurchasingTool,
  getCustomerInsightsTool,
  getPaymentMethodsTool,
  getSyncStatusTool,
  getHourlyHeatmapTool,
  getTopCustomersTool,
  getOpenOrdersDetailTool,
  getHistoricalComparisonTool,
  getOrthoticsCommissionTool,
  getTaxSummaryTool,
  cacheQueryTool,
  cacheVendorActivityTool,
  cacheReadTool,
  refreshSalesNowTool,
];

// Re-export the gated tool callback alone so Property 4 (Task 6.3) can
// drive it directly without spinning up an Agent.
export {
  getOrthoticsCommissionTool,
  ADMIN_REFUSAL,
};

// Suppress unused-export lint by keeping a typed reference to AttachmentRef
// — used by callers consuming the per-turn attachments collector via
// `invocationState.attachments`.
export type { AttachmentRef };
