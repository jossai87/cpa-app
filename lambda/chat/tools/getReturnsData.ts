/**
 * Tool: get_returns_data
 *
 * Return rates and gross return amounts by brand for a year.
 *
 * Lifted verbatim from `case 'get_returns_data':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { round2, todayStr, type ToolContext } from '../helpers';

export interface GetReturnsDataArgs {
  year?: string;
}

export async function getReturnsData(
  args: GetReturnsDataArgs,
  ctx: ToolContext
): Promise<string> {
  const currentYear = todayStr().slice(0, 4);
  const year = args.year === 'current' || !args.year ? currentYear : args.year;
  const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk },
  }));
  const returnRows = (result.Item?.['returnRows'] as Array<Record<string, unknown>> | undefined) ?? [];
  const data = returnRows
    .map(r => {
      const brand = String(r['item.custom@brand'] ?? 'Unknown');
      const grossSales = round2((r['source_sales.gross_sales'] as number) ?? 0);
      const grossReturns = round2(Math.abs((r['source_sales.gross_returns'] as number) ?? 0));
      const grossQtySold = (r['source_sales.gross_qty_sold'] as number) ?? 0;
      const grossQtyReturned = (r['source_sales.gross_qty_returned'] as number) ?? 0;
      const returnRate = grossSales > 0 ? round2((grossReturns / grossSales) * 100) : 0;
      return { brand, grossSales, grossReturns, grossQtySold, grossQtyReturned, returnRatePct: returnRate };
    })
    .filter(r => r.grossSales > 0 || r.grossReturns > 0)
    .sort((a, b) => b.grossReturns - a.grossReturns);
  const totalReturns = round2(data.reduce((s, r) => s + r.grossReturns, 0));
  const totalSales = round2(data.reduce((s, r) => s + r.grossSales, 0));
  return JSON.stringify({
    year,
    totalGrossReturns: totalReturns,
    totalGrossSales: totalSales,
    overallReturnRatePct: totalSales > 0 ? round2((totalReturns / totalSales) * 100) : 0,
    byBrand: data,
  });
}
