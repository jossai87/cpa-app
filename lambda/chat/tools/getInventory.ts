/**
 * Tool: get_inventory
 *
 * Inventory summary, department breakdown, top/low margin items, and
 * low-stock items.
 *
 * Lifted verbatim from `case 'get_inventory':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ToolContext } from '../helpers';

export type InventorySection =
  | 'summary'
  | 'low_stock'
  | 'top_margin'
  | 'low_margin'
  | 'by_department'
  | 'all';

export interface GetInventoryArgs {
  section?: InventorySection;
}

export async function getInventory(
  args: GetInventoryArgs,
  ctx: ToolContext
): Promise<string> {
  const section: InventorySection = args.section ?? 'all';
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk: 'POS#INVENTORY#CATALOG' },
  }));
  const data = result.Item?.['data'] as Record<string, unknown> | undefined;
  if (!data) return JSON.stringify({ error: 'Inventory not synced yet' });
  const out: Record<string, unknown> = {};
  if (section === 'summary' || section === 'all') out['summary'] = data['summary'];
  if (section === 'low_stock' || section === 'all') out['lowStockItems'] = data['lowStockItems'];
  if (section === 'top_margin' || section === 'all') out['topMarginItems'] = (data['topMarginItems'] as unknown[])?.slice(0, 20);
  if (section === 'low_margin' || section === 'all') out['lowMarginItems'] = data['lowMarginItems'];
  if (section === 'by_department' || section === 'all') out['byDepartment'] = data['byDepartment'];
  out['cachedAt'] = result.Item?.['cachedAt'];
  return JSON.stringify(out);
}
