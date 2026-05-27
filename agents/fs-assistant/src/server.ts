/**
 * FS Assistant — Bedrock AgentCore Runtime container entry point.
 *
 * Implements Task 5.2.
 *
 * Exposes the two endpoints AgentCore Runtime requires:
 *   - GET  /ping        → health check (returns {status:'Healthy'})
 *   - POST /invocations → request-handler. Accepts a JSON payload from
 *                         the edge Lambda, runs the orchestrator, and
 *                         returns `{ reply, route, attachments }`.
 *
 * AgentCore session isolation: the per-session runtime ID is delivered
 * via the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` request header
 * (per https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html).
 * We capture it and forward it to the orchestrator via `invocationState`.
 *
 * Failure mode (design.md §Error Handling): on any thrown error we still
 * return HTTP 200 with a graceful reply text — the edge Lambda passes
 * this through unchanged so the user sees a polite message instead of a
 * 500.
 */

import express, { type Request, type Response } from 'express';
import {
  buildOrchestrator,
  buildOrchestratorResult,
  type OrchestratorResult,
} from './orchestrator.js';
import type { InvocationState } from './lib/context.js';

const PORT = Number(process.env['PORT'] ?? 8080);
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

interface InvocationPayload {
  /** Conversation history. Newest user turn last. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Authenticated caller's Cognito sub. */
  callerUserId: string;
  /** True iff the caller is the admin (jandoossai@gmail.com). */
  isAdmin: boolean;
}

interface ServerErrorResult {
  reply: string;
  route: 'general';
  attachments: [];
}

const FAILURE_REPLY: ServerErrorResult = {
  reply: "Sorry, I ran into a problem. Please try again.",
  route: 'general',
  attachments: [],
};

function parsePayload(rawBody: Buffer): InvocationPayload | null {
  try {
    const text = new TextDecoder().decode(rawBody);
    const parsed = JSON.parse(text) as Partial<InvocationPayload>;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      messages: parsed.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : '',
      })),
      callerUserId:
        typeof parsed.callerUserId === 'string' ? parsed.callerUserId : '',
      isAdmin: parsed.isAdmin === true,
    };
  } catch {
    return null;
  }
}

const app = express();

// ── Health check (REQUIRED) ───────────────────────────────────────────
app.get('/ping', (_req: Request, res: Response) => {
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  });
});

// ── Invocation handler (REQUIRED) ─────────────────────────────────────
//
// AgentCore SDK sends a binary payload, so we use express.raw() to grab
// the bytes and decode them ourselves.
app.post(
  '/invocations',
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req: Request, res: Response) => {
    const payload = parsePayload(req.body as Buffer);
    if (!payload) {
      const err: ServerErrorResult = {
        reply: 'Sorry — I could not parse the request.',
        route: 'general',
        attachments: [],
      };
      return res.json(err);
    }
    const sessionHeader = req.header(SESSION_HEADER);
    const sessionId =
      typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : undefined;

    const invocationState: InvocationState = {
      callerUserId: payload.callerUserId,
      isAdmin: payload.isAdmin,
      sessionId,
    };

    // Render the latest user turn into a single prompt for the
    // orchestrator. AgentCore's session-id-based microVM isolation
    // gives us cross-turn continuity automatically.
    const lastUserTurn =
      [...payload.messages].reverse().find((m) => m.role === 'user')?.content ??
      '';

    console.log(
      `[fs-assistant] /invocations userId=${invocationState.callerUserId} isAdmin=${invocationState.isAdmin} prompt=${JSON.stringify(lastUserTurn).slice(0, 200)}`
    );

    // Build a fresh orchestrator + capture bag per request so the
    // sub-agent reply captures don't leak across overlapping turns
    // inside a warm container.
    const { orchestrator, captures } = buildOrchestrator(invocationState);

    try {
      const result = await orchestrator.invoke(lastUserTurn, {
        invocationState: invocationState as unknown as Record<string, unknown>,
      });
      const out: OrchestratorResult = buildOrchestratorResult(result, captures);
      console.log(
        `[fs-assistant] /invocations response route=${out.route} replyLen=${out.reply.length} attachments=${out.attachments.length}`
      );
      return res.json(out);
    } catch (err) {
      console.error(
        '[fs-assistant] orchestrator error:',
        (err as Error).name,
        '-',
        (err as Error).message,
        '\n',
        (err as Error).stack
      );
      // Per design.md Failure mode table: container errors return HTTP
      // 200 with a graceful reply so the edge Lambda passes through.
      return res.json(FAILURE_REPLY);
    }
  }
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[fs-assistant] AgentCore Runtime listening on :${PORT}`);
});
