/**
 * Tool: get_historical_comparison
 *
 * Compare sales performance across multiple years.
 *
 * Lifted verbatim from `case 'get_historical_comparison':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { round2, todayStr, type ToolContext } from '../helpers';

export interface GetHistoricalComparisonArgs {
  years?: string[];
}

export async function getHistoricalComparison(
  args: GetHistoricalComparisonArgs,
  ctx: ToolContext
): Promise<string> {
  const currentYear = todayStr().slice(0, 4);
  const currentYearNum = parseInt(currentYear, 10);
  const requestedYears = args.years ?? [String(currentYearNum - 1), currentYear];
  // Cap at 4 years to avoid huge payloads
  const yearsToFetch = requestedYears.slice(0, 4);
  type YearResult =
    | { year: string; available: false }
    | {
        year: string;
        available: true;
        netSales: number;
        transactions: number;
        avgTicket: number;
        fromDate: unknown;
        toDate: unknown;
        topBrands: Array<{ brand: string; netSales: number }>;
        cachedAt: unknown;
      };
  const results: YearResult[] = await Promise.all(
    yearsToFetch.map(async (yr): Promise<YearResult> => {
      const sk = yr === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${yr}`;
      const r = await ctx.docClient.send(new GetCommand({
        TableName: ctx.tableName,
        Key: { userId: ctx.ownerUserId, sk },
      }));
      if (!r.Item) return { year: yr, available: false };
      const brandRows = (r.Item['brandRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const totalsRows = (r.Item['totalsRows'] as Array<Record<string, unknown>> | undefined) ?? [];
      const netSales = totalsRows.length > 0
        ? round2(totalsRows.reduce((s, t) => s + ((t['source_sales.net_sales'] as number) ?? 0), 0))
        : round2(brandRows.reduce((s, b) => s + ((b['source_sales.net_sales'] as number) ?? 0), 0));
      const transactions = totalsRows.length > 0
        ? totalsRows.reduce((s, t) => s + ((t['source_sales.transaction_count'] as number) ?? 0), 0)
        : brandRows.reduce((s, b) => s + ((b['source_sales.transaction_count'] as number) ?? 0), 0);
      // Top 5 brands for context
      const merged = new Map<string, number>();
      for (const b of brandRows) {
        const brand = ((b['item.custom@brand'] as string | undefined) ?? '').trim().toUpperCase() || '__NULL__';
        merged.set(brand, (merged.get(brand) ?? 0) + ((b['source_sales.net_sales'] as number) ?? 0));
      }
      const topBrands = Array.from(merged.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([brand, sales]) => ({ brand, netSales: round2(sales) }));
      return {
        year: yr,
        available: true,
        netSales,
        transactions,
        avgTicket: transactions > 0 ? round2(netSales / transactions) : 0,
        fromDate: r.Item['fromDate'] ?? `${yr}-01-01`,
        toDate: r.Item['toDate'] ?? `${yr}-12-31`,
        topBrands,
        cachedAt: r.Item['cachedAt'],
      };
    })
  );
  // Compute YoY change between consecutive years
  const comparisons: Array<{ from: string; to: string; salesChangePct: number; salesChangeDollar: number }> = [];
  for (let i = 0; i < results.length - 1; i++) {
    const a = results[i]!;
    const b = results[i + 1]!;
    if (a.available && b.available && typeof a.netSales === 'number' && typeof b.netSales === 'number') {
      const diff = b.netSales - a.netSales;
      comparisons.push({
        from: a.year,
        to: b.year,
        salesChangeDollar: round2(diff),
        salesChangePct: a.netSales > 0 ? round2((diff / a.netSales) * 100) : 0,
      });
    }
  }
  return JSON.stringify({ years: results, yearOverYearChanges: comparisons });
}
