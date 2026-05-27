/**
 * Tool: get_staff_performance
 *
 * Sales aggregated by staff member (sales rep) over a date range.
 *
 * Lifted verbatim from `case 'get_staff_performance':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { daysAgo, round2, todayStr, type ToolContext } from '../helpers';

export interface GetStaffPerformanceArgs {
  from_date?: string;
  to_date?: string;
}

export async function getStaffPerformance(
  args: GetStaffPerformanceArgs,
  ctx: ToolContext
): Promise<string> {
  const today = todayStr();
  const from = args.from_date || daysAgo(30);
  const to = args.to_date || today;
  const result = await ctx.docClient.send(new QueryCommand({
    TableName: ctx.tableName,
    KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':uid': ctx.ownerUserId,
      ':from': `POS#DAILY#${from}`,
      ':to': `POS#DAILY#${to}`,
    },
  }));
  type Rollup = { bySalesRep?: Record<string, number> };
  const repTotals: Record<string, { revenue: number; days: number }> = {};
  for (const item of result.Items ?? []) {
    const r = item['rollup'] as Rollup | undefined;
    if (!r?.bySalesRep) continue;
    for (const [rep, amt] of Object.entries(r.bySalesRep)) {
      if (!repTotals[rep]) repTotals[rep] = { revenue: 0, days: 0 };
      repTotals[rep]!.revenue += amt as number;
      repTotals[rep]!.days += 1;
    }
  }
  const staff = Object.entries(repTotals)
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), activeDays: v.days, avgPerDay: v.days > 0 ? round2(v.revenue / v.days) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
  return JSON.stringify({ from, to, staff });
}
