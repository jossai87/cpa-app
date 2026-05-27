/**
 * Tool: get_sync_status
 *
 * Last sync time and status of each section synced from Heartland POS.
 *
 * Lifted verbatim from `case 'get_sync_status':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ToolContext } from '../helpers';

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface GetSyncStatusArgs {}

export async function getSyncStatus(
  _args: GetSyncStatusArgs,
  ctx: ToolContext
): Promise<string> {
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk: 'POS#SYNC#STATUS' },
  }));
  return JSON.stringify(result.Item ?? { status: 'never synced' });
}
