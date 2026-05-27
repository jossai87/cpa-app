/**
 * Tool: get_payment_methods
 *
 * Sales totals by payment type (cash, credit, etc.) over a date range.
 *
 * Lifted verbatim from `case 'get_payment_methods':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { daysAgo, round2, todayStr, type ToolContext } from '../helpers';

export interface GetPaymentMethodsArgs {
  from_date?: string;
  to_date?: string;
}

export async function getPaymentMethods(
  args: GetPaymentMethodsArgs,
  ctx: ToolContext
): Promise<string> {
  const today = todayStr();
  const from = args.from_date || daysAgo(30);
  const to = args.to_date || today;
  const [rollupsResult, ptResult] = await Promise.all([
    ctx.docClient.send(new QueryCommand({
      TableName: ctx.tableName,
      KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':uid': ctx.ownerUserId,
        ':from': `POS#DAILY#${from}`,
        ':to': `POS#DAILY#${to}`,
      },
    })),
    ctx.docClient.send(new GetCommand({
      TableName: ctx.tableName,
      Key: { userId: ctx.ownerUserId, sk: 'POS#PAYMENT_TYPES#LIST' },
    })),
  ]);
  const ptList = (ptResult.Item?.['types'] as Array<{ id: number; name: string }> | undefined) ?? [];
  const ptMap: Record<string, string> = {};
  for (const p of ptList) ptMap[String(p.id)] = p.name;
  type Rollup = { byPaymentType?: Record<string, { count: number; amount: number }> };
  const totals: Record<string, { count: number; amount: number }> = {};
  for (const item of rollupsResult.Items ?? []) {
    const r = item['rollup'] as Rollup | undefined;
    if (!r?.byPaymentType) continue;
    for (const [id, v] of Object.entries(r.byPaymentType)) {
      if (!totals[id]) totals[id] = { count: 0, amount: 0 };
      totals[id]!.count += v.count;
      totals[id]!.amount += v.amount;
    }
  }
  const methods = Object.entries(totals)
    .map(([id, v]) => ({ name: ptMap[id] ?? `Type ${id}`, count: v.count, amount: round2(v.amount) }))
    .sort((a, b) => b.amount - a.amount);
  return JSON.stringify({ from, to, paymentMethods: methods });
}
