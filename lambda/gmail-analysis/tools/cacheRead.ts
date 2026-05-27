/**
 * cache_read tool callback.
 *
 * Extracted from the runChat / runAnalyze tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Pure refactor: behavior is identical to the original branch — the
 * caller stringifies the returned object as the Bedrock tool result.
 */

import { cacheRead as cacheReadPrimitive } from '../cache';

export interface CacheReadArgs {
  /** Gmail message id. */
  id: string;
  /** Optional YYYY-MM-DD message date for a faster lookup. */
  dateOnly?: string;
}

/**
 * Read the full headers + plaintext body of one cached email by its
 * message ID. Returns the message row when found, otherwise an
 * `{ error }` object — matching the legacy chat / analyze branches.
 */
export async function cacheRead(args: CacheReadArgs): Promise<unknown> {
  const id = String(args.id ?? '');
  const dateOnly = args.dateOnly ? String(args.dateOnly) : undefined;
  const m = await cacheReadPrimitive(id, dateOnly);
  return m ?? { error: `Message ${id} not in cache` };
}
