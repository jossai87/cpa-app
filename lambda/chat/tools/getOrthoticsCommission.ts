/**
 * Tool: get_orthotics_commission
 *
 * Orthotics unit sales and commission breakdown by sales rep.
 * Commission rules: $10/unit for units 1-10, $15/unit for unit 11+.
 *
 * Lifted verbatim from `case 'get_orthotics_commission':` in
 * `lambda/chat/index.ts`. No behaviour change.
 *
 * Admin-gating (Req 6.3) is NOT applied here — this function preserves the
 * legacy `/pos/chat` behaviour. The future Strands Sales_Agent wraps this
 * callback with an `isAdmin` check (per design §3 Sales_Agent / Task 6.1).
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ToolContext } from '../helpers';

export type OrthoticsPeriod = 'today' | '7d' | '30d' | 'monthly' | 'ytd';

export interface GetOrthoticsCommissionArgs {
  period?: OrthoticsPeriod;
}

export async function getOrthoticsCommission(
  args: GetOrthoticsCommissionArgs,
  ctx: ToolContext
): Promise<string> {
  const period: OrthoticsPeriod = args.period ?? 'ytd';
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk: 'POS#REPORTING#ORTHOTICS' },
  }));
  if (!result.Item) {
    return JSON.stringify({ error: 'Orthotics data not synced yet. Click Sync Now on the Staff tab.' });
  }
  type ORow = Record<string, unknown>;
  const rows = (result.Item['orthoticsRepRows'] as ORow[] | undefined) ?? [];
  const ORTHOTICS_PATTERN = /orthotic/i;
  const TIER1_MAX = 10, TIER1_RATE = 10, TIER2_RATE = 15;
  const repUnits: Record<string, number> = {};
  const hasDept = rows.some(r => r['item.department'] != null);
  for (const r of rows) {
    if (hasDept && !ORTHOTICS_PATTERN.test(String(r['item.department'] ?? ''))) continue;
    const rep = String(r['user.name'] ?? r['sales_rep'] ?? 'Unassigned').trim() || 'Unassigned';
    const qty = (r['source_sales.net_qty_sold'] as number) ?? 0;
    if (qty > 0) repUnits[rep] = (repUnits[rep] ?? 0) + qty;
  }
  const reps = Object.entries(repUnits).map(([name, units]) => {
    const tier1 = Math.min(units, TIER1_MAX);
    const tier2 = Math.max(0, units - TIER1_MAX);
    const commission = tier1 * TIER1_RATE + tier2 * TIER2_RATE;
    return { name, units, tier1Units: tier1, tier2Units: tier2, commissionOwed: commission };
  }).sort((a, b) => b.units - a.units);
  const totalCommission = reps.reduce((s, r) => s + r.commissionOwed, 0);
  const depts = [...new Set(
    rows
      .filter(r => ORTHOTICS_PATTERN.test(String(r['item.department'] ?? '')))
      .map(r => String(r['item.department'] ?? ''))
  )];
  return JSON.stringify({
    period,
    commissionRules: `$${TIER1_RATE}/unit for units 1-${TIER1_MAX}, $${TIER2_RATE}/unit for unit ${TIER1_MAX + 1}+`,
    orthoticsDepartments: depts,
    departmentFilterApplied: hasDept,
    reps,
    totalCommissionOwed: totalCommission,
    cachedAt: result.Item['cachedAt'],
  });
}
