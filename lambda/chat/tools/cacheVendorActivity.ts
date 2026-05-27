/**
 * Tool: cache_vendor_activity
 *
 * A vendor's email activity rollup over the last N days.
 * Thin pass-through to `lambda/gmail-analysis/cache.ts#cacheVendorActivity`.
 *
 * Lifted verbatim from `case 'cache_vendor_activity':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { cacheVendorActivity as cacheVendorActivityImpl } from '../../gmail-analysis/cache';

export interface CacheVendorActivityArgs {
  vendor?: string;
  days?: number;
}

export async function cacheVendorActivity(args: CacheVendorActivityArgs): Promise<string> {
  const vendor = String(args.vendor ?? '');
  if (!vendor) return JSON.stringify({ error: 'vendor is required' });
  const days = Math.min(Number(args.days) || 90, 365);
  try {
    return JSON.stringify(await cacheVendorActivityImpl(vendor, days));
  } catch (err) {
    return JSON.stringify({ error: `cache_vendor_activity failed: ${(err as Error).message}` });
  }
}
