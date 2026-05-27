/**
 * Orchestrator factory — builds a fresh top-level FS Assistant agent
 * for every /invocations request.
 *
 * Why per-request and not module-scope?
 *   1. Strands' Agent class has an internal concurrency lock — two
 *      simultaneous `invoke()` calls on the same instance throw
 *      `ConcurrentInvocationError`. AgentCore microVM session isolation
 *      mostly avoids this, but warm-container reuse can collide.
 *   2. The sub-agent reply captures (`salesReply`, `inboxReply`) need
 *      to be request-scoped so concurrent users don't get each other's
 *      data. Threading them through `invocationState` rather than
 *      module-globals makes the architecture safe.
 *   3. The cost is small — Strands Agent construction is cheap (no
 *      Bedrock call, just config wiring) compared to the 25-50s of
 *      Sonnet inference each turn.
 *
 * Tasks 8.1–8.4 are all served here:
 *   - 8.1  Orchestrator with Haiku 4.5 + sub-agent tools
 *   - 8.2  Per-sub-agent 60s Promise.race timeout
 *   - 8.3  Route derivation from per-request captures (TS Strands has
 *          no top-level `tooluseHistory` on AgentResult — we track
 *          which call_*_agent tool fires)
 *   - 8.4  Attachment merge from sub-agent replies
 */

import * as strands from '@strands-agents/sdk';
import { z } from 'zod';
import { salesAgent } from './agents/salesAgent.js';
import { inboxAgent } from './agents/inboxAgent.js';
import {
  withTimeout,
  unavailableReply,
  SubAgentTimeoutError,
} from './lib/timeout.js';
import {
  deriveRoute,
  mergeAttachments,
  type Route,
} from './lib/routing.js';
import type { AttachmentRef } from '../../../lambda/chat/helpers.js';
import type { InvocationState } from './lib/context.js';

interface SubAgentReply {
  reply: string;
  attachments: AttachmentRef[];
  unavailable?: boolean;
}

/**
 * Per-request capture bag. Threaded through Strands' invocationState
 * so sub-agent tool callbacks can mutate it without colliding with
 * other concurrent requests' state.
 */
export interface RequestCaptures {
  sales?: SubAgentReply;
  inbox?: SubAgentReply;
  /** The active InvocationState the sub-agent tool callbacks read. */
  invocationState: InvocationState;
}

/**
 * Read `lastMessage` text out of a Strands `AgentResult`, defending
 * against shape drift between SDK versions.
 */
function extractText(result: { lastMessage?: { content?: unknown } }): string {
  const content = result.lastMessage?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

/**
 * Build a per-sub-agent custom tool. The factory closes over a
 * request-scoped `captures` object so the callback can record the
 * sub-agent's reply + attachments without touching module globals.
 */
function buildSubAgentTool(
  agentName: 'sales' | 'inbox',
  toolName: 'call_sales_agent' | 'call_inbox_agent',
  description: string,
  inner: strands.Agent,
  captures: RequestCaptures
) {
  return strands.tool({
    name: toolName,
    description,
    inputSchema: z.object({
      question: z
        .string()
        .describe(
          'Standalone question for the specialist agent. Include any context (dates, vendor names, etc.) the specialist needs.'
        ),
    }),
    callback: async (input): Promise<string> => {
      const state = captures.invocationState;
      console.log(
        `[fs-assistant] orchestrator -> ${agentName}-agent: ${String(input.question).slice(0, 100)}`
      );
      const attachments: AttachmentRef[] = [];
      const subState: InvocationState = {
        ...state,
        attachments,
      };
      try {
        const result = await withTimeout(
          agentName,
          inner.invoke(input.question, { invocationState: subState })
        );
        const reply = extractText(
          result as { lastMessage?: { content?: unknown } }
        );
        console.log(
          `[fs-assistant] ${agentName}-agent -> orchestrator: ${reply.slice(0, 120)} (${attachments.length} attachments)`
        );
        const captured: SubAgentReply = { reply, attachments };
        if (agentName === 'sales') captures.sales = captured;
        else captures.inbox = captured;
        return reply;
      } catch (err) {
        const reason =
          err instanceof SubAgentTimeoutError
            ? `${unavailableReply(agentName)} (timeout after 60s)`
            : `${unavailableReply(agentName)} (${(err as Error).message ?? 'error'})`;
        console.error(
          `[fs-assistant] ${agentName}-agent failed:`,
          (err as Error).name,
          '-',
          (err as Error).message,
          '\n',
          (err as Error).stack
        );
        const captured: SubAgentReply = {
          reply: reason,
          attachments,
          unavailable: true,
        };
        if (agentName === 'sales') captures.sales = captured;
        else captures.inbox = captured;
        return reason;
      }
    },
  });
}

const ORCHESTRATOR_SYSTEM_PROMPT = `You are FS Assistant, the unified assistant for Foot Solutions Flower Mound.

You have two specialist sub-agents available as tools:
  • call_sales_agent — knows Heartland POS data (sales, inventory, staff, purchasing, brands, returns, vendors, customer-level revenue).
  • call_inbox_agent — knows the owner's Gmail inbox cache (vendor emails, invoices, customer inquiries, attachments, thread reads).

Routing rules:
  1. If the question is purely about POS data, call call_sales_agent ONCE and return its reply VERBATIM. Do not paraphrase or re-summarize. Do not add commentary.
  2. If the question is purely about email, call call_inbox_agent ONCE and return its reply VERBATIM. Do not paraphrase or re-summarize. Do not add commentary.
  3. If the question requires both, call BOTH in the same turn and concatenate their replies under brief "Sales:" and "Inbox:" headings — do NOT rewrite either.
  4. If the question is a greeting, capability question, or off-topic small-talk, answer directly in 1-2 sentences. DO NOT call either tool.
  5. If you genuinely cannot tell which one to call, ask exactly ONE clarifying question. Do not guess.

CRITICAL: Sub-agent replies are already user-ready. Returning them verbatim keeps total turn time under the API budget. Do NOT re-synthesize.

GMAIL LINK PRESERVATION: Sub-agent replies sometimes contain inline message-id citations like \`(msg 19e4210e213176eb)\`. The frontend converts these into clickable "Open in Gmail" links. You MUST preserve every such citation EXACTLY as-is when surfacing a sub-agent reply. Do NOT remove, paraphrase, expand, or reformat \`(msg ...)\` markers.

If a sub-agent reply contains "Sales data is temporarily unavailable" or "Inbox data is temporarily unavailable", surface that phrase verbatim. If both fail, say "I can't reach the data systems right now — please try again in a minute."

Identity: you are speaking with user {callerUserId}. isAdmin={isAdmin}. NEVER mention sub-agent names or routing decisions unless explicitly asked.`;

/**
 * Build a fresh orchestrator + capture bag for one request. The
 * orchestrator's tool list closes over the captures, so the sub-agent
 * replies land in `captures.sales` / `captures.inbox` after the
 * `invoke()` resolves.
 */
export function buildOrchestrator(invocationState: InvocationState): {
  orchestrator: strands.Agent;
  captures: RequestCaptures;
} {
  const captures: RequestCaptures = { invocationState };
  // Sub-agents are module-scope (one per AgentCore microVM session per
  // AWS docs). Their internal Strands lock is fine because per-session
  // microVM isolation already serializes requests within a session.
  // The orchestrator itself we rebuild fresh each turn so the capture
  // bag closes over a request-scoped object — module-scope captures
  // would leak across overlapping turns inside a warm container.
  const callSalesAgent = buildSubAgentTool(
    'sales',
    'call_sales_agent',
    "Delegate to the Sales specialist for any Heartland POS data — sales, inventory, staff, brands, returns, purchasing, customer revenue. Pass a complete standalone question (with dates, vendor names, etc.).",
    salesAgent,
    captures
  );
  const callInboxAgent = buildSubAgentTool(
    'inbox',
    'call_inbox_agent',
    "Delegate to the Inbox specialist for any Gmail inbox question — vendor emails, invoices, customer threads, attachments, specific senders. Pass a complete standalone question.",
    inboxAgent,
    captures
  );
  const orchestrator = new strands.Agent({
    name: 'fs_assistant_orchestrator',
    description: 'FS Assistant — unified Foot Solutions assistant. Routes queries to Sales and Inbox specialist sub-agents.',
    model: new strands.BedrockModel({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 2048,
      temperature: 0.2,
    }),
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    tools: [callSalesAgent, callInboxAgent],
    printer: false,
  });
  return { orchestrator, captures };
}

export interface OrchestratorResult {
  reply: string;
  route: Route;
  attachments: AttachmentRef[];
}

/**
 * Build the per-turn payload from a completed orchestrator invoke.
 * Pure function — exported so PBT tasks can drive it directly.
 */
export function buildOrchestratorResult(
  result: unknown,
  captures: { sales?: SubAgentReply; inbox?: SubAgentReply }
): OrchestratorResult {
  const salesFired = captures.sales !== undefined;
  const inboxFired = captures.inbox !== undefined;
  const route = deriveRoute([
    ...(salesFired ? [{ name: 'call_sales_agent' }] : []),
    ...(inboxFired ? [{ name: 'call_inbox_agent' }] : []),
  ]);
  const reply = extractText(
    (result ?? {}) as { lastMessage?: { content?: unknown } }
  );
  const attachments = mergeAttachments(captures.sales, captures.inbox);
  return { reply, route, attachments };
}
