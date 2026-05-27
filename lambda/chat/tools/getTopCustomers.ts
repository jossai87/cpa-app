/**
 * Tool: get_top_customers
 *
 * Top customers by revenue over a date range.
 *
 * Lifted verbatim from `case 'get_top_customers':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { daysAgo, round2, todayStr, type ToolContext } from '../helpers';

export interface GetTopCustomersArgs {
  from_date?: string;
  to_date?: string;
  top_n?: number;
}

export async function getTopCustomers(
  args: GetTopCustomersArgs,
  ctx: ToolContext
): Promise<string> {
  const today = todayStr();
  const from = args.from_date || daysAgo(30);
  const to = args.to_date || today;
  const topN = Math.min(Number(args.top_n) || 15, 50);
  const result = await ctx.docClient.send(new QueryCommand({
    TableName: ctx.tableName,
    KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':uid': ctx.ownerUserId,
      ':from': `POS#DAILY#${from}`,
      ':to': `POS#DAILY#${to}`,
    },
  }));
  type Rollup = { topCustomers?: Record<string, number> };
  const customerTotals: Record<string, { revenue: number; visits: number }> = {};
  for (const item of result.Items ?? []) {
    const r = item['rollup'] as Rollup | undefined;
    if (!r?.topCustomers) continue;
    for (const [name, amt] of Object.entries(r.topCustomers)) {
      if (!name || name === 'null') continue;
      if (!customerTotals[name]) customerTotals[name] = { revenue: 0, visits: 0 };
      customerTotals[name]!.revenue += amt as number;
      customerTotals[name]!.visits += 1;
    }
  }
  const customers = Object.entries(customerTotals)
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), visits: v.visits, avgPerVisit: v.visits > 0 ? round2(v.revenue / v.visits) : 0 }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topN);
  const totalRevenue = round2(customers.reduce((s, c) => s + c.revenue, 0));
  return JSON.stringify({ from, to, topCustomers: customers, totalRevenueFromNamed: totalRevenue });
}
