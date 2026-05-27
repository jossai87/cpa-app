/**
 * cache_vendor_activity tool callback.
 *
 * Extracted from the runChat tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Pure refactor: behavior is identical to the original branch.
 */

import { cacheVendorActivity as cacheVendorActivityPrimitive } from '../cache';

export interface CacheVendorActivityArgs {
  /** Vendor brand name (e.g. "Brooks", "Aetrex"). */
  vendor: string;
  /** Lookback window in days. Default 90, hard cap 365. */
  days?: number;
}

/**
 * Get a quick rollup of a vendor's recent email activity. Returns the
 * same shape the underlying `cacheVendorActivity` primitive returns;
 * the tool loop stringifies the result before sending it to Bedrock.
 */
export async function cacheVendorActivity(args: CacheVendorActivityArgs) {
  const vendor = String(args.vendor ?? '');
  const days = Math.min(Number(args.days) || 90, 365);
  return cacheVendorActivityPrimitive(vendor, days);
}
