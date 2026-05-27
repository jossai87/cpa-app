/**
 * verifyFollowUp — soft real-time check that a follow-up the user is
 * trying to clear has actually been resolved.
 *
 * Flow:
 *   1. Take the message/thread IDs from the original analysis result.
 *   2. Fetch the latest 5-10 messages from those threads — cache first,
 *      live Gmail as fallback if the cache is stale.
 *   3. Check whether any "newer than the analysis" reply exists. If
 *      not, short-circuit: nothing changed, can't conclude resolution
 *      from the same data the analysis already saw.
 *   4. Hand the recent messages to Claude Sonnet 4.6 (or Haiku 4.5
 *      when the verdict is obvious) with a tight structured-output
 *      schema asking: resolved | unresolved | inconclusive + reason.
 *   5. Cache the verdict by threadId for 5 minutes so a user clicking
 *      "Clear" twice doesn't pay twice.
 *
 * Cost target: ≤ $0.02 per Clear click. Sonnet 4.6 with a 4K-input
 * 200-output prompt is ~$0.015. Haiku 4.5 fast-path is ~$0.002.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { getMessage, getThread } from '../gmail/client';
import { cacheQuery, cacheRead, type CachedQueryArgs } from './cache';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: 'us-east-1' })
);
const TABLE_NAME = process.env['TABLE_NAME'] ?? 'FootSolutionsApp';
const OWNER_USER_ID = process.env['OWNER_USER_ID'] ?? '94989478-c051-7005-9033-3d722963c59b';

const SONNET_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';
const HAIKU_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/** 5-minute verdict cache so rapid double-clicks don't re-pay. */
const VERDICT_CACHE_TTL_SEC = 300;

/** Per-message body cap when feeding to the model (in chars). */
const PER_MESSAGE_BODY_CAP = 1500;

/** Max messages from a thread we'll send to the model. */
const MAX_THREAD_MESSAGES = 10;

export type VerifyVerdict = 'resolved' | 'unresolved' | 'inconclusive';

/**
 * What's being verified. Drives prompt selection and short-circuit
 * heuristics so the model judges the right question.
 *
 *   follow-up — generic "has this thread reached resolution?"
 *   invoice   — "is this invoice paid / closed / no longer outstanding?"
 */
export type VerifyKind = 'follow-up' | 'invoice';

export interface VerifyFollowUpInput {
  /** Stable id derived from the item — used as the verdict cache key. */
  followUpId: string;
  /** What kind of item is being verified. Defaults to "follow-up". */
  kind?: VerifyKind;
  title: string;
  why: string;
  /** Message IDs the original analysis cited for this item. */
  sourceMessageIds: string[];
  /** Thread IDs (preferred — broader context). */
  sourceThreadIds?: string[];
  /** When the original analysis was generated (ISO). */
  analysisGeneratedAt?: string;
  /** Optional invoice-specific context (amount, vendor, dueDate). */
  invoiceContext?: {
    vendor?: string;
    amount?: number | null;
    dueDate?: string | null;
  };
}

export interface VerifyFollowUpOutput {
  verdict: VerifyVerdict;
  /** Human-readable explanation surfaced to the user when not "resolved". */
  reason: string;
  /** True when no new activity since the original analysis — short-circuit path. */
  noNewActivity: boolean;
  /** Set when we found new outbound replies — useful for the "reply went out" callout. */
  latestOutboundDate?: string | undefined;
  /** Set when we found new inbound replies. */
  latestInboundDate?: string | undefined;
  /** ISO timestamp the verdict was computed. */
  verifiedAt: string;
  /** Which model was used. */
  model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
  /** True when this verdict came out of the 5-minute cache. */
  fromCache?: boolean;
}

interface CachedVerdictItem {
  userId: string;
  sk: string;
  followUpId: string;
  verdict: VerifyVerdict;
  reason: string;
  noNewActivity: boolean;
  latestOutboundDate?: string | undefined;
  latestInboundDate?: string | undefined;
  verifiedAt: string;
  model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
  ttl: number;
}

/**
 * Tracks which follow-ups and invoices the user has cleared after a
 * successful verify. Persisted server-side so a page refresh doesn't
 * unhide cleared items.
 *
 * Reset whenever a fresh analysis lands (the IDs are scoped to the
 * analysis they were generated from).
 */
const DISMISSED_SK = 'GMAIL#ANALYSIS_DISMISSED';

interface DismissedRow {
  userId: string;
  sk: string;
  followUpIds: string[];
  invoiceIds: string[];
  /** ISO timestamp of the analysis these IDs were derived from. */
  analysisGeneratedAt?: string;
  updatedAt: string;
}

export async function readDismissed(): Promise<{
  followUpIds: string[];
  invoiceIds: string[];
  analysisGeneratedAt?: string;
}> {
  try {
    const res = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: DISMISSED_SK },
      })
    );
    const item = res.Item as DismissedRow | undefined;
    if (!item) return { followUpIds: [], invoiceIds: [] };
    return {
      followUpIds: Array.isArray(item.followUpIds) ? item.followUpIds : [],
      invoiceIds: Array.isArray(item.invoiceIds) ? item.invoiceIds : [],
      analysisGeneratedAt: item.analysisGeneratedAt,
    };
  } catch {
    return { followUpIds: [], invoiceIds: [] };
  }
}

/** Reset the dismissed-IDs row when a fresh analysis lands. */
export async function resetDismissed(analysisGeneratedAt: string): Promise<void> {
  try {
    const item: DismissedRow = {
      userId: OWNER_USER_ID,
      sk: DISMISSED_SK,
      followUpIds: [],
      invoiceIds: [],
      analysisGeneratedAt,
      updatedAt: new Date().toISOString(),
    };
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error('[verifyFollowUp] resetDismissed error:', (err as Error).message);
  }
}

/**
 * Persist a single dismissal. Reads the current row, inserts the id
 * into the right bucket if not already present, and writes back. We
 * use the analysisGeneratedAt as a fence — if the stored row is from
 * an older analysis, we drop its old IDs (they don't apply to the new
 * indices) before adding the new one.
 */
async function writeDismissed(
  kind: 'follow-up' | 'invoice',
  id: string,
  analysisGeneratedAt?: string
): Promise<void> {
  try {
    const current = await readDismissed();
    let followUpIds = current.followUpIds;
    let invoiceIds = current.invoiceIds;
    let storedAt = current.analysisGeneratedAt;

    // If the stored row is for an older analysis, blow away the prior
    // IDs — index-based keys won't translate.
    if (
      analysisGeneratedAt &&
      storedAt &&
      storedAt !== analysisGeneratedAt
    ) {
      followUpIds = [];
      invoiceIds = [];
      storedAt = analysisGeneratedAt;
    } else if (analysisGeneratedAt && !storedAt) {
      storedAt = analysisGeneratedAt;
    }

    if (kind === 'follow-up') {
      if (!followUpIds.includes(id)) followUpIds = [...followUpIds, id];
    } else {
      if (!invoiceIds.includes(id)) invoiceIds = [...invoiceIds, id];
    }

    const item: DismissedRow = {
      userId: OWNER_USER_ID,
      sk: DISMISSED_SK,
      followUpIds,
      invoiceIds,
      analysisGeneratedAt: storedAt,
      updatedAt: new Date().toISOString(),
    };
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error('[verifyFollowUp] writeDismissed error:', (err as Error).message);
  }
}

interface ThreadMessage {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  bodyText: string;
  /** True when From is the owner / store's outbound address. */
  outbound: boolean;
}

/**
 * Owner-side senders. Anything from these patterns is treated as
 * outbound mail — i.e. a reply WE sent out, which is the signal that
 * "we addressed the follow-up".
 */
const OUTBOUND_SENDER_PATTERNS = [
  /@footsolutions\.com$/i,
  /flowermound@/i,
  /jandoossai@/i,
  /dreamthatbuild@/i,
];

function isOutbound(from: string): boolean {
  const normalized = from.toLowerCase();
  return OUTBOUND_SENDER_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Resolve the canonical Gmail thread IDs for a follow-up.
 *
 * Important: we DO NOT trust client-supplied `sourceThreadIds`. Two
 * reasons:
 *   1. The analysis pipeline historically wrote message IDs into the
 *      threadIds slot when its cache lookup paginated past the
 *      message — those rows are still in DDB.
 *   2. Some message IDs *coincidentally* exist as Gmail thread IDs
 *      themselves (Gmail's auto-replies can produce a single-message
 *      thread whose threadId equals its messageId). Probing the cache
 *      by `threadId` for these will return a single-row hit and lock
 *      the verifier onto the wrong thread, missing the real reply
 *      activity in the parent thread.
 *
 * The robust path is to ask Gmail directly for every `sourceMessageId`
 * we have. Gmail returns the canonical `threadId` for each message;
 * we de-duplicate and return the set. The caller then fetches every
 * resolved thread.
 *
 * Cost: one Gmail `messages.get` per source message (typ. 3-4),
 * paid once per Clear click. Free in dollars; ~150ms in latency.
 */
async function resolveActualThreadIds(
  sourceMessageIds: string[]
): Promise<string[]> {
  const out = new Set<string>();
  for (const id of sourceMessageIds.slice(0, 5)) {
    if (!id) continue;
    try {
      const m = await getMessage(id, 0); // 0 = no body needed, just metadata
      if (m.threadId) out.add(m.threadId);
    } catch (err) {
      console.warn(
        '[verifyFollowUp] getMessage failed for id',
        id,
        '-',
        (err as Error).message
      );
    }
  }
  return [...out];
}

/**
 * Fetch the latest N messages from one or more threads.
 *
 * Strategy: ALWAYS hit live Gmail when we have at least one threadId.
 * The local cache may be minutes (or hours) behind the actual inbox
 * state — exactly the timeframe in which a user clicks Clear after
 * replying — so cache is fallback only.
 *
 * Multi-thread follow-ups (common when the analysis cites messages
 * from related but distinct threads) get full coverage by fetching
 * every resolved thread and merging the result.
 */
async function fetchThreadMessages(
  threadIds: string[],
  messageIds: string[]
): Promise<ThreadMessage[]> {
  const collected: ThreadMessage[] = [];
  const seen = new Set<string>();

  // (a) Live Gmail by threadId — the source of truth.
  for (const threadId of threadIds) {
    if (!threadId) continue;
    try {
      const live = await getThread(threadId, PER_MESSAGE_BODY_CAP);
      for (const m of live.messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        collected.push({
          id: m.id,
          threadId: m.threadId,
          date: m.date,
          from: m.from,
          subject: m.subject,
          bodyText: m.body,
          outbound: isOutbound(m.from),
        });
      }
    } catch (err) {
      console.warn(
        '[verifyFollowUp] live getThread failed for',
        threadId,
        '-',
        (err as Error).message
      );
    }
  }
  if (collected.length > 0) {
    // Keep the most recent messages across all threads — capped at
    // MAX_THREAD_MESSAGES so the prompt stays cheap.
    return collected
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_THREAD_MESSAGES);
  }

  // (b) Cache fallback — broader thread context.
  for (const threadId of threadIds) {
    if (!threadId) continue;
    const args: CachedQueryArgs = { threadId, limit: MAX_THREAD_MESSAGES };
    const result = await cacheQuery(args);
    for (const row of result.rows.slice(0, MAX_THREAD_MESSAGES)) {
      if (seen.has(row.id)) continue;
      const full = await cacheRead(row.id, row.dateOnly);
      if (!full) continue;
      seen.add(full.id);
      collected.push({
        id: full.id,
        threadId: full.threadId,
        date: full.date,
        from: full.from ?? '',
        subject: full.subject ?? '',
        bodyText: (full.bodyText ?? '').slice(0, PER_MESSAGE_BODY_CAP),
        outbound: isOutbound(full.from ?? ''),
      });
    }
  }
  if (collected.length > 0) {
    return collected
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_THREAD_MESSAGES);
  }

  // (c) Last resort — fetch the explicitly-cited messages individually.
  const idsToFetch = messageIds.slice(0, MAX_THREAD_MESSAGES);
  for (const id of idsToFetch) {
    if (seen.has(id)) continue;
    try {
      const m = await getMessage(id, PER_MESSAGE_BODY_CAP);
      seen.add(m.id);
      collected.push({
        id: m.id,
        threadId: m.threadId,
        date: m.date,
        from: m.from,
        subject: m.subject,
        bodyText: m.body,
        outbound: isOutbound(m.from),
      });
    } catch {
      // missing message — skip
    }
  }
  return collected.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Decide whether we can short-circuit (skip the model). Two cases:
 *   1. No messages newer than `analysisGeneratedAt` → nothing changed,
 *      nothing new to verify. Verdict = `unresolved` with the "no new
 *      activity" disclaimer.
 *   2. Only inbound activity (vendor pinged us again) → also unresolved
 *      since we haven't replied yet.
 *
 * This is the cost-optimization core: most "Clear" clicks happen
 * within minutes of the analysis, when nothing has changed. We skip
 * the model entirely for those.
 */
function shortCircuit(
  messages: ThreadMessage[],
  analysisGeneratedAt?: string,
  kind: VerifyKind = 'follow-up'
): VerifyFollowUpOutput | null {
  if (messages.length === 0) {
    return {
      verdict: 'inconclusive',
      reason:
        "Couldn't load this thread from the cache or live Gmail. Try again in a minute.",
      noNewActivity: true,
      verifiedAt: new Date().toISOString(),
      model: 'short-circuit',
    };
  }
  const sorted = [...messages].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const latestOutbound = [...sorted].reverse().find((m) => m.outbound);
  const latestInbound = [...sorted].reverse().find((m) => !m.outbound);

  // Has anything happened since the analysis ran?
  if (analysisGeneratedAt) {
    const cutoff = analysisGeneratedAt;
    const newer = sorted.filter((m) => m.date > cutoff);
    if (newer.length === 0) {
      const noNewActivityReason =
        kind === 'invoice'
          ? "No new replies on this invoice's thread since the last analysis. Without a payment confirmation or vendor acknowledgement we can't auto-close it."
          : "No new replies on this thread since the last analysis. The original issue still appears open — we need a reply or update before we can mark it resolved.";
      return {
        verdict: 'unresolved',
        reason: noNewActivityReason,
        noNewActivity: true,
        latestOutboundDate: latestOutbound?.date,
        latestInboundDate: latestInbound?.date,
        verifiedAt: new Date().toISOString(),
        model: 'short-circuit',
      };
    }
    // New activity only inbound (no outgoing reply yet) — still unresolved.
    // (Skipped for invoices since vendor-only follow-ups don't tell us
    // anything about whether the bill was paid via a different channel.)
    if (kind !== 'invoice') {
      const newerOutbound = newer.filter((m) => m.outbound);
      if (newerOutbound.length === 0) {
        return {
          verdict: 'unresolved',
          reason: `New inbound message on ${
            newer[newer.length - 1]!.date.slice(0, 10)
          } from ${newer[newer.length - 1]!.from} — but no outbound reply yet.`,
          noNewActivity: false,
          latestOutboundDate: latestOutbound?.date,
          latestInboundDate: newer[newer.length - 1]!.date,
          verifiedAt: new Date().toISOString(),
          model: 'short-circuit',
        };
      }
    }
  }

  return null; // need the model
}

/**
 * Build the model prompt. Compact, structured, optimized for the
 * binary classification task.
 */
function buildPrompt(
  input: VerifyFollowUpInput,
  messages: ThreadMessage[]
): { systemPrompt: string; userMessage: string } {
  const kind = input.kind ?? 'follow-up';

  const systemPrompt =
    kind === 'invoice'
      ? `You are an invoice / bill closure checker. Given an invoice item flagged by inbox analysis and the recent messages from the related thread, decide whether the invoice is closed (paid / handled / no longer outstanding).

Output format — STRICT JSON ONLY, no markdown fences, no commentary:
{
  "verdict": "resolved" | "unresolved" | "inconclusive",
  "reason": "<one sentence, max 240 chars>"
}

Rules for "resolved" (invoice closed):
- A payment confirmation, receipt, "thanks for the payment", "balance is zero", "settled", or vendor acknowledgement of payment is present.
- The store explicitly indicates the invoice was paid/handled (e.g. "paid via ACH on 5/22", "check sent", "credit card charged", "duplicate — already paid").
- The invoice was withdrawn or cancelled by the vendor.

Rules for "unresolved":
- No payment confirmation visible, AND no clear indication the invoice was paid.
- Vendor is following up on an unpaid invoice.
- Due date is past and there's still no payment trace.
- Owner asked the vendor a clarifying question that hasn't been answered.

Rules for "inconclusive":
- Thread content doesn't clearly indicate payment status either way.
- The cited thread is about something other than this specific invoice.

Be strict — false "resolved" verdicts mean unpaid bills slip through. When in doubt, say "unresolved" and explain what's missing.`
      : `You are a follow-up resolution checker. Given a follow-up item from an inbox-analysis report and the most recent messages from the related thread, decide whether the issue has been resolved.

Output format — STRICT JSON ONLY, no markdown fences, no commentary:
{
  "verdict": "resolved" | "unresolved" | "inconclusive",
  "reason": "<one sentence, max 240 chars>"
}

Rules for "resolved":
- An outbound reply addresses the original ask, AND
- Either no further inbound message is needed, OR an inbound confirmation has arrived.

Rules for "unresolved":
- No outbound reply yet, OR
- Outbound reply was sent but the thread is clearly waiting on something else (a reply, action, document, payment).

Rules for "inconclusive":
- The thread content is ambiguous or off-topic and you genuinely cannot tell.

Be strict — false "resolved" verdicts cost the owner real money and reputation. When in doubt, say "unresolved" and explain what's missing.`;

  const messageBlocks = messages
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(
      (m) =>
        `--- ${m.outbound ? 'OUTBOUND' : 'INBOUND'} | ${m.date} | from: ${m.from}\nSubject: ${m.subject}\n\n${m.bodyText}\n`
    )
    .join('\n');

  const itemHeader =
    kind === 'invoice'
      ? `Invoice item:\n` +
        `  Vendor: ${input.invoiceContext?.vendor ?? input.title}\n` +
        (input.invoiceContext?.amount != null
          ? `  Amount: $${input.invoiceContext.amount.toFixed(2)}\n`
          : '') +
        (input.invoiceContext?.dueDate
          ? `  Due date: ${input.invoiceContext.dueDate}\n`
          : '') +
        `  Summary: ${input.why}\n\n`
      : `Follow-up item:\n` +
        `  Title: ${input.title}\n` +
        `  Why it was flagged: ${input.why}\n\n`;

  const closingQuestion =
    kind === 'invoice'
      ? `Has this invoice been closed (paid or otherwise resolved)? Return strict JSON only.`
      : `Was this follow-up resolved? Return strict JSON only.`;

  const userMessage =
    itemHeader +
    `Recent thread messages (oldest first):\n\n${messageBlocks}\n\n` +
    closingQuestion;

  return { systemPrompt, userMessage };
}

/**
 * Pick the model. Always returns Sonnet 4.6 — the Haiku 4.5 fast-path
 * was missing too many nuanced cases (vendor "thanks" replies that
 * weren't actually closeouts, payment confirmations buried in long
 * threads, etc.). Cost is ~6x but verify-on-clear is a single
 * user-initiated click so the per-action cost ceiling stays around
 * $0.015.
 */
function pickModel(
  _messages: ThreadMessage[],
  _kind: VerifyKind = 'follow-up'
): 'haiku-4.5' | 'sonnet-4.6' {
  return 'sonnet-4.6';
}

/** Bedrock Converse call with strict JSON output expected. */
async function classifyWithBedrock(
  modelId: string,
  systemPrompt: string,
  userMessage: string
): Promise<{ verdict: VerifyVerdict; reason: string }> {
  const messages: Message[] = [
    { role: 'user', content: [{ text: userMessage }] },
  ];
  const out = await bedrockClient.send(
    new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: { maxTokens: 1024, temperature: 0.1 },
      // Unlock the 1M context window so the model has room to reason
      // about long threads and the full system prompt without
      // truncation. Required when the prompt + thread exceeds ~190k
      // tokens, harmless when it doesn't.
      additionalModelRequestFields: {
        anthropic_beta: ['context-1m-2025-08-07'],
      },
    })
  );
  const text = (out.output?.message?.content ?? [])
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
    .trim();
  // Strip optional ```json fences.
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      verdict?: string;
      reason?: string;
    };
    const verdict: VerifyVerdict =
      parsed.verdict === 'resolved'
        ? 'resolved'
        : parsed.verdict === 'inconclusive'
          ? 'inconclusive'
          : 'unresolved';
    const reason = String(parsed.reason ?? '').slice(0, 280);
    return { verdict, reason };
  } catch {
    // Bedrock returned malformed JSON — treat as inconclusive so the
    // user sees the issue rather than a silent false-positive.
    return {
      verdict: 'inconclusive',
      reason:
        "Couldn't parse the verification result. Please retry or check the thread manually.",
    };
  }
}

/** Stable cache key for the verdict. */
function verdictSk(followUpId: string): string {
  return `FOLLOWUP_VERIFY#${followUpId}`;
}

async function readCachedVerdict(
  followUpId: string
): Promise<VerifyFollowUpOutput | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { userId: OWNER_USER_ID, sk: verdictSk(followUpId) },
      })
    );
    const item = result.Item as CachedVerdictItem | undefined;
    if (!item) return null;
    if (item.ttl < Math.floor(Date.now() / 1000)) return null;
    return {
      verdict: item.verdict,
      reason: item.reason,
      noNewActivity: item.noNewActivity,
      latestOutboundDate: item.latestOutboundDate,
      latestInboundDate: item.latestInboundDate,
      verifiedAt: item.verifiedAt,
      model: item.model,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

async function writeCachedVerdict(
  followUpId: string,
  out: VerifyFollowUpOutput
): Promise<void> {
  try {
    const item: CachedVerdictItem = {
      userId: OWNER_USER_ID,
      sk: verdictSk(followUpId),
      followUpId,
      verdict: out.verdict,
      reason: out.reason,
      noNewActivity: out.noNewActivity,
      latestOutboundDate: out.latestOutboundDate,
      latestInboundDate: out.latestInboundDate,
      verifiedAt: out.verifiedAt,
      model: out.model,
      ttl: Math.floor(Date.now() / 1000) + VERDICT_CACHE_TTL_SEC,
    };
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch {
    // Cache write failure is non-fatal.
  }
}

/**
 * Top-level entry: returns the verdict for one follow-up.
 * Hits the 5-minute cache first, then runs the short-circuit check,
 * then falls through to the chosen model.
 */
export async function verifyFollowUp(
  input: VerifyFollowUpInput
): Promise<VerifyFollowUpOutput> {
  // 1. Cache hit?
  const cached = await readCachedVerdict(input.followUpId);
  if (cached) return cached;

  const kind: VerifyKind = input.kind ?? 'follow-up';

  // 2. Resolve the actual threadIds. We don't trust client-supplied
  //    `sourceThreadIds` — see `resolveActualThreadIds` for why
  //    (auto-replies, message-id-as-threadId collisions). We always
  //    re-derive from the message IDs via Gmail's API.
  const sourceMessageIds = input.sourceMessageIds ?? [];
  const actualThreadIds = await resolveActualThreadIds(sourceMessageIds);

  // 3. Fetch thread messages (live Gmail first, cache fallback).
  const messages = await fetchThreadMessages(actualThreadIds, sourceMessageIds);

  // 4. Short-circuit check.
  const shortCut = shortCircuit(messages, input.analysisGeneratedAt, kind);
  if (shortCut) {
    // Don't cache short-circuit verdicts — they're nearly free to
    // recompute, and caching them risks pinning a stale "no new
    // activity" verdict in place exactly when the user is replying.
    return shortCut;
  }

  // 5. Model classification.
  const model = pickModel(messages, kind);
  const modelId = model === 'haiku-4.5' ? HAIKU_MODEL_ID : SONNET_MODEL_ID;
  const { systemPrompt, userMessage } = buildPrompt(input, messages);
  const { verdict, reason } = await classifyWithBedrock(
    modelId,
    systemPrompt,
    userMessage
  );

  const sorted = [...messages].sort((a, b) => a.date.localeCompare(b.date));
  const latestOutbound = [...sorted].reverse().find((m) => m.outbound);
  const latestInbound = [...sorted].reverse().find((m) => !m.outbound);

  const out: VerifyFollowUpOutput = {
    verdict,
    reason: reason || 'Verified.',
    noNewActivity: false,
    latestOutboundDate: latestOutbound?.date,
    latestInboundDate: latestInbound?.date,
    verifiedAt: new Date().toISOString(),
    model,
  };
  await writeCachedVerdict(input.followUpId, out);

  // Persist the dismissal server-side so a page refresh doesn't bring
  // the cleared item back. We only persist on a verified `resolved`
  // verdict — anything else stays visible with the disclaimer.
  if (verdict === 'resolved') {
    await writeDismissed(kind, input.followUpId, input.analysisGeneratedAt);
  }

  return out;
}
