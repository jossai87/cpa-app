/**
 * Barrel re-exports for the per-tool extracted Sales chat functions.
 *
 * One file per tool — see Task 1.2 in the fs-assistant-orchestrator spec.
 * The legacy `executeTool` switch in `lambda/chat/index.ts` dispatches
 * to these; the future Strands `Sales_Agent` will wrap each as a `tool({...})`
 * callback (Task 6.1).
 */

export { callInboxAssistant } from './callInboxAssistant';
export { getVendorContacts } from './getVendorContacts';
export { getSalesSummary } from './getSalesSummary';
export { getReturnsData } from './getReturnsData';
export { getInventory } from './getInventory';
export { getStaffPerformance } from './getStaffPerformance';
export { getBrandPerformance } from './getBrandPerformance';
export { getPurchasing } from './getPurchasing';
export { getCustomerInsights } from './getCustomerInsights';
export { getPaymentMethods } from './getPaymentMethods';
export { getSyncStatus } from './getSyncStatus';
export { getHourlyHeatmap } from './getHourlyHeatmap';
export { getTopCustomers } from './getTopCustomers';
export { getOpenOrdersDetail } from './getOpenOrdersDetail';
export { getHistoricalComparison } from './getHistoricalComparison';
export { getOrthoticsCommission } from './getOrthoticsCommission';
export { getTaxSummary } from './getTaxSummary';
export { cacheQuery } from './cacheQuery';
export { cacheVendorActivity } from './cacheVendorActivity';
export { cacheRead } from './cacheRead';
export { refreshSalesNow } from './refreshSalesNow';

// Re-export argument enum types so Strands tool wrappers can refer to
// them without reaching past the barrel into individual files.
export type { InventorySection } from './getInventory';
export type { PurchasingSection } from './getPurchasing';
export type { OrthoticsPeriod } from './getOrthoticsCommission';
