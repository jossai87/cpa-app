/**
 * live_read_email tool callback.
 *
 * Extracted from the runChat / runAnalyze tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Fallback path that fetches a single message directly from the live
 * Gmail API (typically used when `live_search_inbox` returned an id
 * that is not yet present in the local cache). Pure refactor —
 * behavior is identical to the original branch / `execReadEmail`
 * helper; the tool loop stringifies the returned object before
 * sending it to Bedrock.
 */

import { getMessage } from '../../gmail/client';

export interface LiveReadEmailArgs {
  /** Gmail message id. */
  id: string;
}

/**
 * Read one live Gmail message by id. Returns the full message object
 * on success, or `{ error: string }` on a missing id or upstream
 * failure — matching the legacy `execReadEmail` shape.
 */
export async function liveReadEmail(
  args: LiveReadEmailArgs
): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };
  try {
    return await getMessage(id);
  } catch (err) {
    return { error: `read_email failed: ${(err as Error).message}` };
  }
}
