/**
 * cache_query tool callback.
 *
 * Extracted from the runChat / runAnalyze tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Pure refactor: behavior is identical to the original branch.
 */

import { cacheQuery as cacheQueryPrimitive, type CachedQueryArgs } from '../cache';

export type CacheQueryArgs = CachedQueryArgs;

/**
 * Query the local Gmail cache. Returns the same `{ total, rows }` shape
 * the underlying primitive returns; the chat / analyze tool loop
 * `JSON.stringify`s the result before sending it back to Bedrock.
 */
export async function cacheQuery(args: CacheQueryArgs): Promise<unknown> {
  return cacheQueryPrimitive(args);
}
