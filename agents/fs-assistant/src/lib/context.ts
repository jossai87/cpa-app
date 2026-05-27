/**
 * Build the legacy `ToolContext` (from `lambda/chat/helpers.ts`) from a
 * Strands `invocationState`. Sales tools were lifted verbatim from the
 * existing /pos/chat Lambda; they expect:
 *
 *   - `docClient` (DynamoDBDocumentClient)
 *   - `tableName`
 *   - `ownerUserId`
 *   - `callerUserId` (optional)
 *   - `attachmentCollector` (optional, populated by cache_read)
 *
 * The Strands `invocationState` carries `{ callerUserId, isAdmin, sessionId }`
 * per turn (set by the orchestrator on every sub-agent call). The DynamoDB
 * client and table/owner constants live at module scope and are imported
 * from this module by every Sales tool wrapper.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AttachmentRef, ToolContext } from '../../../../lambda/chat/helpers.js';

const REGION = process.env['AWS_REGION'] ?? 'us-east-1';
const dynamoClient = new DynamoDBClient({ region: REGION });
export const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const TABLE_NAME = process.env['TABLE_NAME'] ?? 'FootSolutionsApp';
export const OWNER_USER_ID =
  process.env['OWNER_USER_ID'] ?? '94989478-c051-7005-9033-3d722963c59b';

/**
 * Per-turn state held in the Strands `invocationState`.
 * The orchestrator sets these on every call into a sub-agent.
 */
export interface InvocationState extends Record<string, unknown> {
  callerUserId: string;
  isAdmin: boolean;
  sessionId?: string | undefined;
  /**
   * Per-turn attachment collector. The orchestrator allocates a fresh
   * array for each invocation; `cache_read` pushes into it so the
   * Inbox_Agent's `metadata.attachments` can surface it back to the
   * edge Lambda.
   */
  attachments?: AttachmentRef[] | undefined;
}

/**
 * Read the per-turn `InvocationState` off a Strands `ToolContext`.
 * Throws if context is missing — sub-agent tool callbacks always run
 * inside an invocation that the orchestrator created.
 */
export function readInvocationState(
  ctx: { invocationState: Record<string, unknown> } | undefined
): InvocationState {
  if (!ctx?.invocationState) {
    throw new Error('ToolContext.invocationState is missing');
  }
  const s = ctx.invocationState as Partial<InvocationState>;
  return {
    callerUserId: String(s['callerUserId'] ?? ''),
    isAdmin: Boolean(s['isAdmin']),
    sessionId: typeof s['sessionId'] === 'string' ? s['sessionId'] : undefined,
    attachments: Array.isArray(s['attachments']) ? s['attachments'] : undefined,
  };
}

/**
 * Build the `ToolContext` shape the lifted Sales tool functions expect.
 * Pulls the per-turn `callerUserId` and `attachments` collector out of
 * `invocationState`; everything else is module-level constants.
 */
export function buildToolContext(
  invocationState: InvocationState
): ToolContext {
  return {
    docClient,
    tableName: TABLE_NAME,
    ownerUserId: OWNER_USER_ID,
    callerUserId: invocationState.callerUserId,
    attachmentCollector: invocationState.attachments,
  };
}
