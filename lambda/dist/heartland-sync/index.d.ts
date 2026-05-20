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
export declare const handler: (event?: ScheduledEvent | {
    trigger?: string;
}) => Promise<Record<string, unknown>>;
//# sourceMappingURL=index.d.ts.map