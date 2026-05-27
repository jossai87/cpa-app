/**
 * Tool: get_hourly_heatmap
 *
 * Revenue by hour of day aggregated across a date range, optionally filtered
 * to a specific weekday.
 *
 * Lifted verbatim from `case 'get_hourly_heatmap':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { daysAgo, round2, todayStr, type ToolContext } from '../helpers';

export interface GetHourlyHeatmapArgs {
  from_date?: string;
  to_date?: string;
  day_of_week?: string;
}

export async function getHourlyHeatmap(
  args: GetHourlyHeatmapArgs,
  ctx: ToolContext
): Promise<string> {
  const today = todayStr();
  const from = args.from_date || daysAgo(30);
  const to = args.to_date || today;
  const dayFilter = args.day_of_week?.toLowerCase();
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const result = await ctx.docClient.send(new QueryCommand({
    TableName: ctx.tableName,
    KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':uid': ctx.ownerUserId,
      ':from': `POS#DAILY#${from}`,
      ':to': `POS#DAILY#${to}`,
    },
  }));
  type Rollup = { date: string; byHour?: Record<string, number> };
  const hourTotals: Record<string, { revenue: number; days: number }> = {};
  let daysIncluded = 0;
  for (const item of result.Items ?? []) {
    const r = item['rollup'] as Rollup | undefined;
    if (!r?.byHour) continue;
    // Apply day-of-week filter if requested
    if (dayFilter) {
      const d = new Date(r.date + 'T12:00:00');
      const dayName = DAY_NAMES[d.getDay()];
      if (dayName !== dayFilter) continue;
    }
    daysIncluded++;
    for (const [hour, amt] of Object.entries(r.byHour)) {
      if (!hourTotals[hour]) hourTotals[hour] = { revenue: 0, days: 0 };
      hourTotals[hour]!.revenue += amt as number;
      hourTotals[hour]!.days += 1;
    }
  }
  const hours = Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, '0');
    const t = hourTotals[key] ?? { revenue: 0, days: 0 };
    const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
    return {
      hour: h, label,
      totalRevenue: round2(t.revenue),
      avgRevenue: t.days > 0 ? round2(t.revenue / t.days) : 0,
      daysActive: t.days,
    };
  }).filter(h => h.totalRevenue > 0);
  const peak = hours.reduce(
    (best, h) => h.avgRevenue > best.avgRevenue ? h : best,
    hours[0] ?? { label: 'none', avgRevenue: 0 }
  );
  return JSON.stringify({
    from, to,
    dayFilter: dayFilter ?? 'all days',
    daysIncluded,
    peakHour: peak,
    byHour: hours,
  });
}
