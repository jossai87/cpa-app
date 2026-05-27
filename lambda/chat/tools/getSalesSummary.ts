/**
 * Tool: get_sales_summary
 *
 * Sales revenue, ticket count, discounts, and average ticket size for a
 * date range, with a per-day breakdown.
 *
 * Lifted verbatim from `case 'get_sales_summary':` in
 * `lambda/chat/index.ts`. No behaviour change.
 *
 * Real-time freshness: when the requested date range includes today's
 * date (in Central Time), the tool first invokes the heartland-sync
 * Lambda with `trigger: 'today-only'` so today's payments+tickets are
 * pulled from the Heartland API just-in-time, then reads the freshly
 * updated `POS#DAILY#YYYY-MM-DD` row. This is enforced HERE rather
 * than relying on the LLM to remember to pre-refresh.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { daysAgo, round2, todayStr, type ToolContext } from '../helpers';

const lambdaClient = new LambdaClient({ region: 'us-east-1' });
const SYNC_FN_NAME =
  process.env['HEARTLAND_SYNC_FN'] ?? 'foot-solutions-pos-sync';

export interface GetSalesSummaryArgs {
  from_date?: string;
  to_date?: string;
}

/**
 * Trigger a slim Heartland today-only sync. Returns the sync function's
 * result so the caller can surface upstream errors (e.g. Heartland 500s)
 * to the user instead of showing stale or empty data as if it were the
 * truth.
 */
async function refreshTodayBeforeRead(): Promise<{
  ok: boolean;
  paymentsError?: string;
}> {
  try {
    const out = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SYNC_FN_NAME,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ trigger: 'today-only' })),
      })
    );
    if (out.FunctionError) {
      return { ok: false, paymentsError: `Sync function error: ${out.FunctionError}` };
    }
    const text = out.Payload
      ? new TextDecoder().decode(out.Payload as Uint8Array)
      : '{}';
    const parsed = JSON.parse(text) as {
      payments?: { error?: string };
    };
    if (parsed.payments?.error) {
      return { ok: false, paymentsError: parsed.payments.error };
    }
    return { ok: true };
  } catch (err) {
    console.error(
      '[get_sales_summary] today-only refresh failed (continuing with cached data):',
      (err as Error).message
    );
    return { ok: false, paymentsError: (err as Error).message };
  }
}

export async function getSalesSummary(
  args: GetSalesSummaryArgs,
  ctx: ToolContext
): Promise<string> {
  const today = todayStr();
  const from = args.from_date || daysAgo(30);
  const to = args.to_date || today;

  // Real-time freshness: if the requested range includes today, pull
  // today's payments+tickets fresh from Heartland before reading the
  // cache. This adds 3-8s to the request but guarantees the user sees
  // accurate same-day numbers (the scheduled background sync runs every
  // 6 hours and is therefore stale for "today" queries by definition).
  let refreshNote: string | undefined;
  if (from <= today && today <= to) {
    const refresh = await refreshTodayBeforeRead();
    if (!refresh.ok) {
      refreshNote = `Heartland API is currently returning errors for today's payments (${refresh.paymentsError?.slice(0, 200) ?? 'unknown'}). The numbers below reflect the last successful sync (up to ~6 hours old).`;
    }
  }

  const result = await ctx.docClient.send(new QueryCommand({
    TableName: ctx.tableName,
    KeyConditionExpression: 'userId = :uid AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':uid': ctx.ownerUserId,
      ':from': `POS#DAILY#${from}`,
      ':to': `POS#DAILY#${to}`,
    },
  }));
  const items = result.Items ?? [];
  type Rollup = { date: string; count: number; totalAmount: number; totalDiscounts: number };
  let revenue = 0, tickets = 0, discounts = 0;
  const daily: Array<{ date: string; revenue: number; tickets: number }> = [];
  for (const item of items) {
    const r = item['rollup'] as Rollup | undefined;
    if (!r) continue;
    revenue += r.totalAmount ?? 0;
    tickets += r.count ?? 0;
    discounts += r.totalDiscounts ?? 0;
    daily.push({ date: r.date, revenue: round2(r.totalAmount), tickets: r.count });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return JSON.stringify({
    from, to,
    totalRevenue: round2(revenue),
    totalTickets: tickets,
    totalDiscounts: round2(discounts),
    avgTicket: tickets > 0 ? round2(revenue / tickets) : 0,
    daysWithSales: daily.length,
    dailyBreakdown: daily,
    ...(refreshNote ? { upstreamWarning: refreshNote } : {}),
  });
}
