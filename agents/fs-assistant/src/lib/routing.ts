/**
 * Pure routing & attachment-merge helpers for the orchestrator.
 *
 * Both functions are pure (no I/O) and exported for property-based testing:
 *   - Property 1 (Routing decision matches sub-agent call set) — Task 8.5
 *   - Property 7 (Attachment metadata round-trip) — Task 8.7
 *
 * The orchestrator wires them in `orchestrator.ts` after each invoke().
 */

import type { AttachmentRef } from '../../../../lambda/chat/helpers.js';

export type Route = 'sales' | 'inbox' | 'both' | 'general';

/**
 * Minimal shape of a tool-use entry the orchestrator can introspect after
 * its agent loop completes. Strands' `result.tooluseHistory` returns a
 * superset of this; we only care about the tool name.
 */
export interface ToolUseEntry {
  /** Name of the tool that fired (e.g. 'call_sales_agent'). */
  name?: string;
  toolName?: string;
  /** Strands TS sometimes exposes the use under `tool` — accommodate both. */
  tool?: { name?: string };
}

/**
 * Derive the per-turn `route` from the orchestrator's tool-use history.
 *
 * Mapping (from design.md §Routing decision in metadata):
 *   call_sales_agent fired only         → 'sales'
 *   call_inbox_agent fired only         → 'inbox'
 *   both fired (any order, any count)   → 'both'
 *   neither fired                       → 'general'
 *
 * Other tool-use entries (e.g. internal sub-agent tool calls that bubble
 * up) are ignored.
 *
 * Property 1 covers this: any combination of arbitrary entries containing
 * zero or more `call_sales_agent` and `call_inbox_agent` should map per
 * the table above.
 */
export function deriveRoute(history: readonly ToolUseEntry[] | undefined): Route {
  if (!history || history.length === 0) return 'general';
  let sales = false;
  let inbox = false;
  for (const entry of history) {
    const name =
      entry.name ?? entry.toolName ?? entry.tool?.name ?? '';
    if (name === 'call_sales_agent') sales = true;
    else if (name === 'call_inbox_agent') inbox = true;
  }
  if (sales && inbox) return 'both';
  if (sales) return 'sales';
  if (inbox) return 'inbox';
  return 'general';
}

/**
 * Concatenate attachment metadata from the two sub-agents' replies.
 *
 * Preserves order and element identity (Property 7 / Task 8.4):
 *   - Sales attachments come first, then Inbox.
 *     In practice only Inbox produces attachments today, but the merge
 *     is symmetric so the contract holds if Sales ever surfaces files.
 *   - `undefined` and missing fields are treated as empty arrays.
 *   - Each element is passed through unchanged (no deep clone, no field
 *     mutation) — Property 7 asserts deep-equal element identity.
 */
export function mergeAttachments(
  salesMeta?: { attachments?: readonly AttachmentRef[] | undefined } | undefined,
  inboxMeta?: { attachments?: readonly AttachmentRef[] | undefined } | undefined
): AttachmentRef[] {
  const sales = salesMeta?.attachments ?? [];
  const inbox = inboxMeta?.attachments ?? [];
  return [...sales, ...inbox];
}
