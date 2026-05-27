/**
 * Tool: get_brand_performance
 *
 * Net sales, units sold, and transaction count by brand for a year.
 *
 * Lifted verbatim from `case 'get_brand_performance':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { round2, todayStr, type ToolContext } from '../helpers';

export interface GetBrandPerformanceArgs {
  year?: string;
  top_n?: number;
}

export async function getBrandPerformance(
  args: GetBrandPerformanceArgs,
  ctx: ToolContext
): Promise<string> {
  const currentYear = todayStr().slice(0, 4);
  const year = args.year === 'current' || !args.year ? currentYear : args.year;
  const topN = args.top_n || 20;
  const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk },
  }));
  const brandRows = (result.Item?.['brandRows'] as Array<Record<string, unknown>> | undefined) ?? [];
  // Merge case-insensitive duplicates
  const merged = new Map<string, { brand: string; netSales: number; netQty: number; transactions: number }>();
  for (const r of brandRows) {
    const raw = ((r['item.custom@brand'] as string | undefined) ?? '').trim();
    const key = raw.toUpperCase() || '__NULL__';
    let entry = merged.get(key);
    if (!entry) { entry = { brand: raw || '(no brand)', netSales: 0, netQty: 0, transactions: 0 }; merged.set(key, entry); }
    entry.netSales += (r['source_sales.net_sales'] as number) ?? 0;
    entry.netQty += (r['source_sales.net_qty_sold'] as number) ?? 0;
    entry.transactions += (r['source_sales.transaction_count'] as number) ?? 0;
  }
  const brands = Array.from(merged.values())
    .map(b => ({ ...b, netSales: round2(b.netSales) }))
    .sort((a, b) => b.netSales - a.netSales)
    .slice(0, topN);
  return JSON.stringify({ year, brands });
}
