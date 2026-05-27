/**
 * cache_stats tool callback.
 *
 * Extracted from the runChat tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Pure refactor: behavior is identical to the original branch.
 */

import { cacheStats as cacheStatsPrimitive } from '../cache';

// The cache_stats Bedrock toolSpec declares no input properties;
// keep an empty Args type for symmetry with the other tool callbacks.
export type CacheStatsArgs = Record<string, never>;

/**
 * Coverage stats for the local cache (oldest/newest message date,
 * totals by kind). Returns the same shape the underlying primitive
 * returns; the tool loop stringifies it before sending to Bedrock.
 */
export async function cacheStats(_args: CacheStatsArgs = {} as CacheStatsArgs) {
  return cacheStatsPrimitive();
}
