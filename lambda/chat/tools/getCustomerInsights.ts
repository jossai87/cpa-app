/**
 * Tool: get_customer_insights
 *
 * Customer retention metrics — total customers, repeat vs new, and repeat
 * revenue — for a given year.
 *
 * Lifted verbatim from `case 'get_customer_insights':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { round2, todayStr, type ToolContext } from '../helpers';

export interface GetCustomerInsightsArgs {
  year?: string;
}

export async function getCustomerInsights(
  args: GetCustomerInsightsArgs,
  ctx: ToolContext
): Promise<string> {
  const currentYear = todayStr().slice(0, 4);
  const year = args.year === 'current' || !args.year ? currentYear : args.year;
  const sk = year === currentYear ? 'POS#REPORTING#SALES' : `POS#REPORTING#YEAR#${year}`;
  const result = await ctx.docClient.send(new GetCommand({
    TableName: ctx.tableName,
    Key: { userId: ctx.ownerUserId, sk },
  }));
  const customerRows = (result.Item?.['customerRows'] as Array<Record<string, unknown>> | undefined) ?? [];
  const totalCustomers = customerRows.filter(r => r['customer.public_id']).length;
  const repeatCustomers = customerRows.filter(r => ((r['source_sales.transaction_count'] as number) ?? 0) > 1).length;
  const newCustomers = totalCustomers - repeatCustomers;
  const repeatRevenue = round2(customerRows
    .filter(r => ((r['source_sales.transaction_count'] as number) ?? 0) > 1)
    .reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0));
  return JSON.stringify({
    year, totalCustomers, repeatCustomers, newCustomers,
    repeatRate: totalCustomers > 0 ? round2((repeatCustomers / totalCustomers) * 100) : 0,
    repeatRevenue,
  });
}
