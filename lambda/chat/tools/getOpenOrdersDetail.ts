/**
 * Tool: get_open_orders_detail
 *
 * Open / pending purchase orders with aging analysis, optionally filtered
 * by vendor or minimum days open.
 *
 * Lifted verbatim from `case 'get_open_orders_detail':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { round2, type ToolContext } from '../helpers';

export interface GetOpenOrdersDetailArgs {
  vendor_name?: string;
  min_days_open?: number;
}

export async function getOpenOrdersDetail(
  args: GetOpenOrdersDetailArgs,
  ctx: ToolContext
): Promise<string> {
  const vendorFilter = (args.vendor_name ?? '').toLowerCase().trim();
  const minDays = Number(args.min_days_open) || 0;
  const [ordersResult, vendorsResult] = await Promise.all([
    ctx.docClient.send(new GetCommand({
      TableName: ctx.tableName,
      Key: { userId: ctx.ownerUserId, sk: 'POS#PURCHASING#ORDERS' },
    })),
    ctx.docClient.send(new GetCommand({
      TableName: ctx.tableName,
      Key: { userId: ctx.ownerUserId, sk: 'POS#PURCHASING#VENDORS' },
    })),
  ]);
  type Order = {
    id: number;
    public_id?: string;
    status?: string;
    vendor_id?: number;
    vendorName?: string;
    total_qty?: number;
    total_cost?: number;
    total_open_qty?: number;
    created_at?: string;
  };
  const orders = (ordersResult.Item?.['orders'] as Order[] | undefined) ?? [];
  const vendorRank = (vendorsResult.Item?.['vendorRank'] as Array<{ vendorId: number; vendorName: string }> | undefined) ?? [];
  const vendorNameMap: Record<number, string> = {};
  for (const v of vendorRank) vendorNameMap[v.vendorId] = v.vendorName;
  const now = Date.now();
  const enriched = orders
    .map(o => {
      const name = o.vendorName ?? vendorNameMap[o.vendor_id ?? -1] ?? `Vendor ${o.vendor_id}`;
      const created = o.created_at ? new Date(o.created_at) : null;
      const daysOpen = created ? Math.floor((now - created.getTime()) / 86400000) : null;
      return {
        poNumber: o.public_id ?? String(o.id),
        vendorName: name,
        status: o.status ?? 'unknown',
        createdAt: o.created_at ?? null,
        daysOpen,
        qtyOrdered: o.total_qty ?? 0,
        qtyOpen: o.total_open_qty ?? 0,
        qtyReceived: (o.total_qty ?? 0) - (o.total_open_qty ?? 0),
        totalCost: round2(o.total_cost ?? 0),
        aging: daysOpen === null ? 'unknown' : daysOpen <= 7 ? 'fresh' : daysOpen <= 30 ? 'normal' : daysOpen <= 60 ? 'aging' : 'overdue',
      };
    })
    .filter(o => !vendorFilter || o.vendorName.toLowerCase().includes(vendorFilter))
    .filter(o => minDays === 0 || (o.daysOpen !== null && o.daysOpen >= minDays))
    .sort((a, b) => (b.daysOpen ?? 0) - (a.daysOpen ?? 0));
  // Vendor-level summary
  const byVendor: Record<string, { orders: number; totalCost: number; totalOpenQty: number; oldestDays: number }> = {};
  for (const o of enriched) {
    if (!byVendor[o.vendorName]) byVendor[o.vendorName] = { orders: 0, totalCost: 0, totalOpenQty: 0, oldestDays: 0 };
    byVendor[o.vendorName]!.orders += 1;
    byVendor[o.vendorName]!.totalCost += o.totalCost;
    byVendor[o.vendorName]!.totalOpenQty += o.qtyOpen;
    byVendor[o.vendorName]!.oldestDays = Math.max(byVendor[o.vendorName]!.oldestDays, o.daysOpen ?? 0);
  }
  const vendorSummary = Object.entries(byVendor)
    .map(([name, v]) => ({
      vendorName: name,
      openOrders: v.orders,
      totalCommittedCost: round2(v.totalCost),
      totalOpenUnits: v.totalOpenQty,
      oldestOrderDays: v.oldestDays,
    }))
    .sort((a, b) => b.totalCommittedCost - a.totalCommittedCost);
  return JSON.stringify({
    filter: vendorFilter || 'all vendors',
    minDaysOpen: minDays,
    totalOpenOrders: enriched.length,
    totalCommittedCost: round2(enriched.reduce((s, o) => s + o.totalCost, 0)),
    vendorSummary,
    orders: enriched,
  });
}
