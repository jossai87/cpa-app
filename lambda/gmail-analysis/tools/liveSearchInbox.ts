/**
 * live_search_inbox tool callback.
 *
 * Extracted from the runChat / runAnalyze tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Fallback path that hits the LIVE Gmail API when the cache does not
 * yet cover the time window the question needs. Pure refactor —
 * behavior is identical to the original branch / `execSearchInbox`
 * helper; the tool loop stringifies the returned object before
 * sending it to Bedrock.
 */

import { searchEmails } from '../../gmail/client';

export interface LiveSearchInboxArgs {
  /** Gmail query syntax string. */
  query: string;
  /** Max results to return. Default 10, hard cap 25. */
  max?: number;
}

/**
 * Search the live Gmail inbox by Gmail query syntax. Returns either
 *   { query, count, messages: [...] }
 * on success, or
 *   { error: string }
 * on a missing query or upstream failure — matching the legacy
 * `execSearchInbox` shape.
 */
export async function liveSearchInbox(
  args: LiveSearchInboxArgs
): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required' };
  const max = Math.min(Number(args.max) || 10, 25);
  try {
    const matches = await searchEmails(query, max);
    return { query, count: matches.length, messages: matches };
  } catch (err) {
    return { error: `search_inbox failed: ${(err as Error).message}` };
  }
}
