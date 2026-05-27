/**
 * Strands tool wrappers for the Inbox_Agent.
 *
 * One Strands `tool({...})` per extracted Gmail tool function in
 * `lambda/gmail-analysis/tools/`. The callbacks delegate to the existing
 * imported function and return the same shape the legacy `/gmail/chat`
 * Lambda's tool branches emitted (so the Inbox_Agent's prompt-time
 * behaviour is identical).
 *
 * Attachment-metadata side-channel (Requirements 5.2, 8.2 / Task 7.1):
 * `cache_read` and `live_read_email` push attachment metadata into the
 * per-turn `invocationState.attachments` collector so the orchestrator
 * can merge it into the response payload.
 *
 * Strands' `tool({...})` callback must return a `JSONValue`. The
 * underlying Gmail primitives return `unknown` (cache rows) and typed
 * objects (vendor activity, kb hits). We JSON-stringify each result so
 * the model sees a deterministic textual blob — matching the legacy
 * `/gmail/chat` Lambda's behaviour where every tool result was
 * stringified before being attached as a Bedrock toolResult content
 * block.
 *
 * Tasks: 7.1 (build the wrappers), 7.2 (mount them in inboxAgent.ts).
 */

import * as strands from '@strands-agents/sdk';
import * as gmailTools from '../../../../../lambda/gmail-analysis/tools/index.js';
import type { AttachmentRef } from '../../../../../lambda/chat/helpers.js';
import { readInvocationState } from '../../lib/context.js';

const {
  cacheQuery: cacheQueryFn,
  cacheRead: cacheReadFn,
  cacheStats: cacheStatsFn,
  cacheVendorActivity: cacheVendorActivityFn,
  kbSemanticSearch: kbSemanticSearchFn,
  liveReadEmail: liveReadEmailFn,
  liveSearchInbox: liveSearchInboxFn,
} = gmailTools;

/**
 * Annotate cache/live tool results with a per-row "must cite as (msg X)"
 * hint. The Inbox sub-agent's system prompt mandates inline citations,
 * but Haiku 4.5 occasionally drops them. Embedding the citation hint
 * into the tool result itself (which the model reads back to itself
 * during the agent loop) gives a much stronger signal than the system
 * prompt alone.
 */
function annotateForCitation(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(annotateForCitation);
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // Single message row — add the cite hint.
    if (typeof obj['id'] === 'string') {
      const id = obj['id'];
      return { ...obj, _cite_as: `(msg ${id})` };
    }
    // Container — recurse into children, with a special case for the
    // `recentMessageIds: string[]` shape that cache_vendor_activity
    // returns. Convert each bare id into `{id, _cite_as}` so the model
    // sees the cite hint inline.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === 'recentMessageIds' &&
        Array.isArray(v) &&
        v.every((x) => typeof x === 'string')
      ) {
        out[k] = (v as string[]).map((id) => ({
          id,
          _cite_as: `(msg ${id})`,
        }));
      } else {
        out[k] = annotateForCitation(v);
      }
    }
    return out;
  }
  return payload;
}

/**
 * Best-effort "did the read return attachment metadata?" check.
 * Both cache and live primitives return a row whose `attachments`
 * field is `Array<{filename, mimeType, size, attachmentId}>` when
 * the message had MIME parts. We only push when we see a non-empty
 * array.
 */
function collectAttachments(
  state: { attachments?: AttachmentRef[] | undefined },
  row: unknown
): void {
  if (!state.attachments) return;
  if (!row || typeof row !== 'object') return;
  const r = row as {
    id?: string;
    subject?: string;
    attachments?: AttachmentRef['attachments'];
  };
  if (!r.id || !Array.isArray(r.attachments) || r.attachments.length === 0) return;
  state.attachments.push({
    messageId: r.id,
    subject: r.subject,
    attachments: r.attachments,
  });
}

// ── cache_query ──────────────────────────────────────────────────────
const cacheQueryTool = strands.tool({
  name: 'cache_query',
  description:
    'Search the local Gmail cache (rolling ~6 month copy of the inbox). Filter by vendor / kind / from / text / since / until. Returns metadata only — call cache_read for body.',
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Vendor brand (Brooks, Dansko, Aetrex, etc.)' },
      kind: { type: 'string', enum: ['invoice', 'vendor', 'customer', 'internal'] },
      since: { type: 'string', description: 'YYYY-MM-DD inclusive' },
      until: { type: 'string', description: 'YYYY-MM-DD inclusive' },
      from: { type: 'string', description: 'From-header substring' },
      text: { type: 'string', description: 'Subject/snippet substring' },
      threadId: { type: 'string' },
      limit: { type: 'number', description: 'Default 25, max 100' },
    },
  },
  callback: async (input): Promise<string> => {
    const out = await cacheQueryFn(input as Parameters<typeof cacheQueryFn>[0]);
    return JSON.stringify(annotateForCitation(out));
  },
});

// ── cache_read ───────────────────────────────────────────────────────
const cacheReadTool = strands.tool({
  name: 'cache_read',
  description:
    'Read full body of a cached email by id. Returns headers, plaintext body, and an `attachments` array — mention filenames to the user when present.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      dateOnly: { type: 'string', description: 'Optional YYYY-MM-DD for a faster lookup' },
    },
    required: ['id'],
  },
  callback: async (input, context): Promise<string> => {
    const state = readInvocationState(context);
    const row = await cacheReadFn(input as { id: string; dateOnly?: string });
    collectAttachments(state, row);
    return JSON.stringify(annotateForCitation(row));
  },
});

// ── cache_vendor_activity ────────────────────────────────────────────
const cacheVendorActivityTool = strands.tool({
  name: 'cache_vendor_activity',
  description:
    "Get a vendor's recent email activity rollup: message count, last contact date, top senders, top subjects, recent message IDs. Returned message IDs come pre-annotated with `_cite_as: \"(msg <id>)\"` — copy those tokens VERBATIM into your final reply for any message you reference.",
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      days: { type: 'number', description: 'Default 90, max 365' },
    },
    required: ['vendor'],
  },
  callback: async (input): Promise<string> => {
    const out = await cacheVendorActivityFn(
      input as { vendor: string; days?: number }
    );
    return JSON.stringify(annotateForCitation(out));
  },
});

// ── cache_stats ──────────────────────────────────────────────────────
const cacheStatsTool = strands.tool({
  name: 'cache_stats',
  description:
    'Coverage stats for the local Gmail cache (oldest/newest message date, totals by kind). Use to check whether the cache covers the date range a question needs before falling back to live search.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  callback: async (): Promise<string> => {
    const out = await cacheStatsFn();
    return JSON.stringify(out);
  },
});

// ── kb_semantic_search ───────────────────────────────────────────────
const kbSemanticSearchTool = strands.tool({
  name: 'kb_semantic_search',
  description:
    "Semantic / fuzzy search over message bodies. Use when the question is conceptual ('anyone complaining about fit', 'pricing concerns') and exact-match cache_query won't find it.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search query' },
      top_k: { type: 'number', description: 'Default 8, max 25' },
    },
    required: ['query'],
  },
  callback: async (input): Promise<string> => {
    const out = await kbSemanticSearchFn(
      input as { query: string; top_k?: number }
    );
    return JSON.stringify(annotateForCitation(out));
  },
});

// ── live_search_inbox ────────────────────────────────────────────────
const liveSearchInboxTool = strands.tool({
  name: 'live_search_inbox',
  description:
    'Search the LIVE Gmail inbox by Gmail query syntax. Use only when cache_stats shows the cache does not cover the date range needed.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail query syntax string' },
      max: { type: 'number', description: 'Default 10, max 25' },
    },
    required: ['query'],
  },
  callback: async (input): Promise<string> => {
    const out = await liveSearchInboxFn(input as { query: string; max?: number });
    return JSON.stringify(annotateForCitation(out));
  },
});

// ── live_read_email ──────────────────────────────────────────────────
const liveReadEmailTool = strands.tool({
  name: 'live_read_email',
  description:
    "Read one live Gmail message by id. Use when an id from live_search_inbox is not yet in the local cache.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  callback: async (input, context): Promise<string> => {
    const state = readInvocationState(context);
    const row = await liveReadEmailFn(input as { id: string });
    collectAttachments(state, row);
    return JSON.stringify(annotateForCitation(row));
  },
});

// ── resolve_thread_ids — small helper that lets the agent map a
// "thread X" reference to the message ids in that thread without doing
// a full cache_query.
const resolveThreadIdsTool = strands.tool({
  name: 'resolve_thread_ids',
  description:
    'Given a Gmail threadId, return the list of message ids in that thread (most recent first). Useful for following a back-and-forth conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'string' },
      limit: { type: 'number', description: 'Default 20, max 100' },
    },
    required: ['threadId'],
  },
  callback: async (input): Promise<string> => {
    const args = input as { threadId: string; limit?: number };
    const limit = Math.min(Number(args.limit) || 20, 100);
    const out = await cacheQueryFn({ threadId: args.threadId, limit });
    return JSON.stringify(annotateForCitation(out));
  },
});

/**
 * Final Inbox_Agent tool list — 8 tools, all Gmail-scoped, no POS access.
 * Matches design.md §3 Inbox_Agent.
 */
export const INBOX_TOOLS = [
  cacheQueryTool,
  cacheReadTool,
  cacheVendorActivityTool,
  cacheStatsTool,
  kbSemanticSearchTool,
  liveSearchInboxTool,
  liveReadEmailTool,
  resolveThreadIdsTool,
];
