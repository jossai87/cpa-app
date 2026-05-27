/**
 * Tool: get_purchasing
 *
 * Vendor list, open purchase orders, and vendor rankings by PO volume.
 *
 * Lifted verbatim from `case 'get_purchasing':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ToolContext } from '../helpers';

export type PurchasingSection = 'vendors' | 'open_orders' | 'vendor_rank' | 'all';

export interface GetPurchasingArgs {
  section?: PurchasingSection;
}

export async function getPurchasing(
  args: GetPurchasingArgs,
  ctx: ToolContext
): Promise<string> {
  const section: PurchasingSection = args.section ?? 'all';
  const [vendorsResult, ordersResult] = await Promise.all([
    ctx.docClient.send(new GetCommand({
      TableName: ctx.tableName,
      Key: { userId: ctx.ownerUserId, sk: 'POS#PURCHASING#VENDORS' },
    })),
    ctx.docClient.send(new GetCommand({
      TableName: ctx.tableName,
      Key: { userId: ctx.ownerUserId, sk: 'POS#PURCHASING#ORDERS' },
    })),
  ]);
  const out: Record<string, unknown> = {};
  if (section === 'vendors' || section === 'all') out['vendors'] = vendorsResult.Item?.['vendors'];
  if (section === 'vendor_rank' || section === 'all') out['vendorRank'] = vendorsResult.Item?.['vendorRank'];
  if (section === 'open_orders' || section === 'all') {
    out['openOrders'] = ordersResult.Item?.['orders'];
    out['totalOrdersAllTime'] = ordersResult.Item?.['totalOrders'];
  }
  return JSON.stringify(out);
}
