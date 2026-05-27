/**
 * Promise.race-based per-sub-agent timeout helper.
 *
 * Implements Requirement 9.4: each sub-agent invocation MUST be wrapped
 * in a 60s timer; on timeout the orchestrator's tool wrapper returns
 * `{ error, available: false }` so the orchestrator's system prompt can
 * continue answering any other-domain portion of the question
 * (Requirements 9.1, 9.2).
 *
 * Pure function — exported so Property 2 (Single-domain failure isolation)
 * can drive it directly from fast-check (Task 8.6).
 */

export const SUB_AGENT_TIMEOUT_MS = 60_000;

export class SubAgentTimeoutError extends Error {
  constructor(public agent: 'sales' | 'inbox', timeoutMs: number) {
    super(`${agent} sub-agent exceeded ${timeoutMs}ms`);
    this.name = 'SubAgentTimeoutError';
  }
}

/**
 * Race the inner promise against a timer. On timeout, throws
 * SubAgentTimeoutError tagged with the sub-agent name.
 */
export async function withTimeout<T>(
  agent: 'sales' | 'inbox',
  inner: Promise<T>,
  timeoutMs = SUB_AGENT_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SubAgentTimeoutError(agent, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([inner, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Format the failure-mode reply text per the design's "Failure mode table"
 * (design.md §Error Handling): "<Sales|Inbox> data is temporarily
 * unavailable". This is the exact phrase Property 2 asserts on, so it
 * lives in one place.
 */
export function unavailableReply(agent: 'sales' | 'inbox'): string {
  const label = agent === 'sales' ? 'Sales' : 'Inbox';
  return `${label} data is temporarily unavailable`;
}
