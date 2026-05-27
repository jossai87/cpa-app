/**
 * Tool: cache_read
 *
 * Read the full body of a cached email by id.
 * Thin pass-through to `lambda/gmail-analysis/cache.ts#cacheRead`, with a
 * side effect: when the message has attachments, push their metadata into
 * the per-turn `attachmentCollector` so the chat handler can return them
 * to the frontend for `<AttachmentChip />` rendering.
 *
 * Lifted verbatim from `case 'cache_read':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { cacheRead as cacheReadImpl } from '../../gmail-analysis/cache';
import type { ToolContext } from '../helpers';

export interface CacheReadArgs {
  id?: string;
  dateOnly?: string;
}

export async function cacheRead(
  args: CacheReadArgs,
  ctx: ToolContext
): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) return JSON.stringify({ error: 'id is required' });
  const dateOnly = String(args.dateOnly ?? '') || undefined;
  try {
    const m = await cacheReadImpl(id, dateOnly);
    if (m && m.attachments && m.attachments.length > 0) {
      // Track for the final response so the frontend can render chips
      if (ctx.attachmentCollector) {
        ctx.attachmentCollector.push({
          messageId: m.id,
          subject: m.subject,
          attachments: m.attachments,
        });
      }
    }
    return JSON.stringify(m ?? { error: `Message ${id} not in cache` });
  } catch (err) {
    return JSON.stringify({ error: `cache_read failed: ${(err as Error).message}` });
  }
}
