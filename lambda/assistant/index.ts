/**
 * assistantEdgeFn — edge Lambda for the unified FS Assistant.
 *
 * Routes:
 *   POST /assistant/chat                    — kick off (returns 202 + sessionId)
 *   GET  /assistant/chat/{sessionId}        — poll for status / result
 *
 * Implements Tasks 11.1–11.5 + the async pattern from CpaTaxAssistant.
 *
 * Why async (vs sync)?
 *   AgentCore Runtime + Strands sub-agents on Sonnet 4.6 routinely take
 *   25-60s per turn. API Gateway HTTP API has a hard 30s integration
 *   timeout, which prevents sync. The CPA tax assistant uses the same
 *   pattern: write a "pending" row, self-invoke async, the
 *   background invocation runs the heavy work and updates the row when
 *   done. The frontend polls the GET endpoint every 2-3s until status
 *   transitions to `complete` or `error`.
 *
 * Order of operations on POST /assistant/chat:
 *   1. Feature-flag gate (`ASSISTANT_ENABLED=true`)
 *   2. JWT extraction → `callerUserId`, `isAdmin`
 *   3. Validation (8000-char + 50-turn limits)
 *   4. Rate limit (60 req/min per `callerUserId`)
 *   5. Generate sessionId, write pending row to DDB
 *   6. lambda:Invoke self with `__internal__: 'runOrchestrator'`
 *   7. Return 202 with sessionId immediately
 *
 * Background worker (`runOrchestratorBackground`):
 *   1. Calls AgentCore InvokeAgentRuntime (no timeout pressure)
 *   2. On success, write the result + status='complete' to the pending row
 *   3. On failure, write status='error' with the error message
 *   4. Persist chat history if applicable
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// ── Module-scope clients (re-used across cold/warm invocations) ──────
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const agentCore = new BedrockAgentCoreClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

// ── Env-var-bound constants ──────────────────────────────────────────
const TABLE_NAME = process.env['TABLE_NAME'] ?? 'FootSolutionsApp';
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'jandoossai@gmail.com';
const ADMIN_SUB = 'f4682498-d0d1-70cd-c302-27ff64bb2b6e';
const ASSISTANT_ENABLED = process.env['ASSISTANT_ENABLED'] === 'true';
const FS_ASSISTANT_RUNTIME_ARN =
  process.env['FS_ASSISTANT_RUNTIME_ARN'] ?? '';
const RUNTIME_QUALIFIER = process.env['RUNTIME_QUALIFIER'] ?? 'DEFAULT';
const SELF_FUNCTION_NAME =
  process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? 'foot-solutions-assistant-edge';

// ── Limits (design.md §Failure mode table + Req 13) ─────────────────
const MAX_MESSAGE_CHARS = 8000;
const MAX_TURNS = 50;
const RATE_LIMIT_PER_MIN = 60;
const RATE_TTL_SECONDS = 120;
const SESSION_TTL_SECONDS = 24 * 3600; // pending row expires in 24h
const HISTORY_TTL_DAYS = 30;

// ── Types ─────────────────────────────────────────────────────────────
interface ClientMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  route?: Route;
  attachments?: AttachmentRef[];
}

interface AttachmentRef {
  messageId: string;
  subject?: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
}

type Route = 'sales' | 'inbox' | 'both' | 'general';

interface AssistantRequestBody {
  messages?: ClientMessage[];
  sessionId?: string;
}

interface OrchestratorResponse {
  reply: string;
  route: Route;
  attachments: AttachmentRef[];
}

interface PendingSessionItem {
  userId: string;
  sk: string;
  sessionId: string;
  status: 'processing' | 'complete' | 'error';
  reply?: string;
  route?: Route;
  attachments?: AttachmentRef[];
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
  ttl: number;
}

// Background self-invocation payload — recognised by the entry handler
// to dispatch to the orchestrator worker instead of an HTTP route.
interface InternalEvent {
  __internal__: 'runOrchestrator';
  userId: string;
  sessionId: string;
  isAdmin: boolean;
  messages: ClientMessage[];
}

// ── HTTP helpers ─────────────────────────────────────────────────────
function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  };
}

function getCallerSub(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  return String(event.requestContext.authorizer.jwt.claims['sub'] ?? '');
}

function getCallerEmail(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): string {
  return String(
    event.requestContext.authorizer.jwt.claims['email'] ?? ''
  ).toLowerCase();
}

function isAdminCaller(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): boolean {
  const email = getCallerEmail(event);
  if (email && email === ADMIN_EMAIL.toLowerCase()) return true;
  const sub = getCallerSub(event);
  if (sub && sub === ADMIN_SUB) return true;
  return false;
}

// ── Rate limit ───────────────────────────────────────────────────────
async function consumeRateBudget(
  userId: string,
  limit = RATE_LIMIT_PER_MIN
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const sk = `RATE#${userId}#${bucket}`;
  const ttl = now + RATE_TTL_SECONDS;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId, sk },
        UpdateExpression: 'ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
        ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': limit,
          ':ttl': ttl,
        },
      })
    );
    return { allowed: true };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'ConditionalCheckFailedException') {
      const retryAfter = 60 - (now % 60);
      return { allowed: false, retryAfter };
    }
    console.error('[assistant] rate-limit check error:', (err as Error).message);
    return { allowed: true };
  }
}

// ── Session row helpers ──────────────────────────────────────────────
function sessionSk(sessionId: string): string {
  return `ASSISTANT_SESSION#${sessionId}`;
}

async function writePendingSession(
  userId: string,
  sessionId: string
): Promise<void> {
  const item: PendingSessionItem = {
    userId,
    sk: sessionSk(sessionId),
    sessionId,
    status: 'processing',
    startedAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, sk: item.sk },
      UpdateExpression:
        'SET #s = :s, sessionId = :sid, startedAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': item.status,
        ':sid': item.sessionId,
        ':now': item.startedAt,
        ':ttl': item.ttl,
      },
    })
  );
}

async function writeCompleteSession(
  userId: string,
  sessionId: string,
  payload: OrchestratorResponse
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, sk: sessionSk(sessionId) },
      UpdateExpression:
        'SET #s = :s, reply = :r, route = :route, attachments = :a, completedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': payload.reply,
        ':route': payload.route,
        ':a': payload.attachments,
        ':now': new Date().toISOString(),
      },
    })
  );
}

async function writeErroredSession(
  userId: string,
  sessionId: string,
  errorMessage: string
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, sk: sessionSk(sessionId) },
      UpdateExpression:
        'SET #s = :s, errorMessage = :err, completedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'error',
        ':err': errorMessage.slice(0, 500),
        ':now': new Date().toISOString(),
      },
    })
  );
}

async function readSession(
  userId: string,
  sessionId: string
): Promise<PendingSessionItem | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId, sk: sessionSk(sessionId) },
    })
  );
  return (result.Item as PendingSessionItem | undefined) ?? null;
}

// ── History persistence ──────────────────────────────────────────────
function historyTtl(): number {
  return Math.floor(Date.now() / 1000) + HISTORY_TTL_DAYS * 86400;
}

async function persistHistory(
  userId: string,
  sessionId: string,
  messages: ClientMessage[]
): Promise<void> {
  const sk = `CHAT_HISTORY#assistant#${sessionId}`;
  const now = new Date().toISOString();
  const firstUser = messages.find((m) => m.role === 'user');
  const preview = firstUser?.content.slice(0, 120) ?? '';
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId, sk },
        UpdateExpression:
          'SET sessionId = :sid, #t = :type, preview = if_not_exists(preview, :preview), startedAt = if_not_exists(startedAt, :now), lastMessageAt = :now, messages = :msgs, #ttl = :ttl',
        ExpressionAttributeNames: { '#t': 'type', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':sid': sessionId,
          ':type': 'assistant',
          ':preview': preview,
          ':now': now,
          ':msgs': messages,
          ':ttl': historyTtl(),
        },
      })
    );
  } catch (err) {
    console.error('[assistant] history write error:', (err as Error).message);
  }
}

// ── Custom CW metrics ────────────────────────────────────────────────
async function emitMetrics(
  route: Route,
  latencyMs: number,
  unavailable?: boolean
): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: 'FsAssistant',
        MetricData: [
          {
            MetricName: 'AssistantRouteCount',
            Value: 1,
            Unit: StandardUnit.Count,
            Dimensions: [{ Name: 'route', Value: route }],
          },
          {
            MetricName: 'OrchestratorTurnLatencyMs',
            Value: latencyMs,
            Unit: StandardUnit.Milliseconds,
          },
          ...(unavailable
            ? [
                {
                  MetricName: 'SubAgentUnavailable',
                  Value: 1,
                  Unit: StandardUnit.Count,
                },
              ]
            : []),
        ],
      })
    );
  } catch (err) {
    console.error('[assistant] CW metrics error:', (err as Error).message);
  }
}

// ── AgentCore invocation ─────────────────────────────────────────────
async function invokeOrchestrator(
  payload: { messages: ClientMessage[]; callerUserId: string; isAdmin: boolean },
  sessionId: string
): Promise<
  | { ok: true; result: OrchestratorResponse }
  | { ok: false; errorMessage: string }
> {
  if (!FS_ASSISTANT_RUNTIME_ARN) {
    return { ok: false, errorMessage: 'FS_ASSISTANT_RUNTIME_ARN not set' };
  }
  try {
    const out = await agentCore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: FS_ASSISTANT_RUNTIME_ARN,
        runtimeSessionId: sessionId,
        runtimeUserId: payload.callerUserId,
        qualifier: RUNTIME_QUALIFIER,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      })
    );
    if (!out.response) {
      return { ok: false, errorMessage: 'AgentCore returned empty body' };
    }
    const text = await out.response.transformToString();
    const parsed = JSON.parse(text) as Partial<OrchestratorResponse>;
    return {
      ok: true,
      result: {
        reply: typeof parsed.reply === 'string' ? parsed.reply : '',
        route: (parsed.route as Route) ?? 'general',
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments
          : [],
      },
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error('[assistant] AgentCore error:', e.name, e.message);
    return {
      ok: false,
      errorMessage: e.message ?? 'unknown AgentCore error',
    };
  }
}

// ── Background worker ────────────────────────────────────────────────
//
// Invoked async from `handlePostChat` via `lambda:Invoke({InvocationType:
// 'Event', ...})`. Writes the result to the session row when done; the
// frontend's polling GET picks it up.
async function runOrchestratorBackground(job: InternalEvent): Promise<void> {
  const { userId, sessionId, isAdmin, messages } = job;
  const start = Date.now();
  try {
    const result = await invokeOrchestrator(
      { messages, callerUserId: userId, isAdmin },
      sessionId
    );
    const latencyMs = Date.now() - start;
    if (!result.ok) {
      await emitMetrics('general', latencyMs, true);
      await writeErroredSession(userId, sessionId, result.errorMessage);
      return;
    }
    await emitMetrics(result.result.route, latencyMs);
    await writeCompleteSession(userId, sessionId, result.result);

    // Persist chat history (Req 7.1) — save every successful turn so a
    // user can re-open even a one-question conversation. We previously
    // gated on >=2 user turns / >=4 messages, which dropped every
    // single-turn chat on the floor.
    const turnsToSave: ClientMessage[] = [
      ...messages,
      {
        role: 'assistant',
        content: result.result.reply,
        timestamp: new Date().toISOString(),
        route: result.result.route,
        attachments: result.result.attachments,
      },
    ];
    await persistHistory(userId, sessionId, turnsToSave);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error';
    console.error('[assistant] background worker error:', msg);
    await writeErroredSession(userId, sessionId, msg);
  }
}

function isInternalEvent(event: unknown): event is InternalEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { __internal__?: string }).__internal__ === 'runOrchestrator'
  );
}

// ── HTTP handlers ────────────────────────────────────────────────────
async function handlePostChat(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!ASSISTANT_ENABLED) {
    return json(404, { error: 'Not found' });
  }

  const callerUserId = getCallerSub(event);
  if (!callerUserId) return json(401, { error: 'Unauthorized' });
  const isAdmin = isAdminCaller(event);

  let body: AssistantRequestBody;
  try {
    body = JSON.parse(event.body ?? '{}') as AssistantRequestBody;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (
    lastUserMsg &&
    typeof lastUserMsg.content === 'string' &&
    lastUserMsg.content.length > MAX_MESSAGE_CHARS
  ) {
    return json(400, {
      error: `Message too long (${lastUserMsg.content.length} chars). Limit is ${MAX_MESSAGE_CHARS}.`,
    });
  }

  if (messages.length > MAX_TURNS) {
    // Synthetic turn-cap reply — no AgentCore call. Fits the same
    // poll-or-return shape as a normal completed session so the
    // frontend can render it identically.
    const sessionId = body.sessionId ?? randomUUID();
    return json(200, {
      sessionId,
      status: 'complete',
      reply:
        'This conversation is getting long. Tap **New chat** to start fresh.',
      route: 'general',
      attachments: [],
    });
  }

  if (messages.length === 0 || !lastUserMsg) {
    return json(400, { error: 'messages must include at least one user turn' });
  }

  const rate = await consumeRateBudget(callerUserId);
  if (!rate.allowed) {
    return json(
      429,
      { error: 'Slow down a bit', retryAfterSec: rate.retryAfter },
      { 'Retry-After': String(rate.retryAfter) }
    );
  }

  const sessionId = body.sessionId ?? randomUUID();
  await writePendingSession(callerUserId, sessionId);

  // Self-invoke async — frees the HTTP request to return in <1s.
  try {
    const internal: InternalEvent = {
      __internal__: 'runOrchestrator',
      userId: callerUserId,
      sessionId,
      isAdmin,
      messages,
    };
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(internal)),
      })
    );
  } catch (err) {
    console.error('[assistant] self-invoke failed:', (err as Error).message);
    await writeErroredSession(callerUserId, sessionId, 'Failed to start orchestrator');
    return json(500, { error: 'Could not start the assistant.' });
  }

  return json(202, {
    sessionId,
    status: 'processing',
  });
}

async function handleGetChat(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!ASSISTANT_ENABLED) return json(404, { error: 'Not found' });

  const callerUserId = getCallerSub(event);
  if (!callerUserId) return json(401, { error: 'Unauthorized' });

  const sessionId = event.pathParameters?.['sessionId'];
  if (!sessionId) return json(400, { error: 'sessionId path parameter is required' });

  const item = await readSession(callerUserId, sessionId);
  if (!item) return json(404, { error: 'Session not found' });

  // Always include the sessionId so the frontend doesn't have to track it
  // separately. The status drives the rest of the response shape.
  if (item.status === 'complete') {
    return json(200, {
      sessionId,
      status: 'complete',
      reply: item.reply ?? '',
      route: item.route ?? 'general',
      attachments: item.attachments ?? [],
    });
  }
  if (item.status === 'error') {
    return json(200, {
      sessionId,
      status: 'error',
      errorMessage:
        item.errorMessage ?? 'The assistant ran into a problem. Please try again.',
    });
  }
  return json(200, { sessionId, status: 'processing' });
}

// ── Lambda entry ──────────────────────────────────────────────────────
type AnyEvent = APIGatewayProxyEventV2WithJWTAuthorizer | InternalEvent;

export async function handler(
  event: AnyEvent
): Promise<APIGatewayProxyResultV2 | void> {
  // Background worker — no HTTP response.
  if (isInternalEvent(event)) {
    await runOrchestratorBackground(event);
    return;
  }

  const apiEvent = event as APIGatewayProxyEventV2WithJWTAuthorizer;
  const route = apiEvent.routeKey;
  if (route === 'POST /assistant/chat') return handlePostChat(apiEvent);
  if (route === 'GET /assistant/chat/{sessionId}') return handleGetChat(apiEvent);
  return json(404, { error: 'Not found' });
}

// ── PBT exports ──────────────────────────────────────────────────────
export {
  consumeRateBudget,
  persistHistory,
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  RATE_LIMIT_PER_MIN,
};
export type {
  ClientMessage,
  AttachmentRef,
  Route,
  OrchestratorResponse,
  AssistantRequestBody,
  PendingSessionItem,
};
