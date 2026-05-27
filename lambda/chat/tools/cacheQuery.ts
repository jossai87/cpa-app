/**
 * Tool: cache_query
 *
 * Search the local Gmail cache (rolling ~6 month copy of the inbox).
 * Thin pass-through to `lambda/gmail-analysis/cache.ts#cacheQuery`.
 *
 * Lifted verbatim from `case 'cache_query':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { cacheQuery as cacheQueryImpl, type CachedQueryArgs } from '../../gmail-analysis/cache';

export type CacheQueryArgs = CachedQueryArgs;

export async function cacheQuery(args: CacheQueryArgs): Promise<string> {
  try {
    const result = await cacheQueryImpl(args);
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: `cache_query failed: ${(err as Error).message}` });
  }
}
