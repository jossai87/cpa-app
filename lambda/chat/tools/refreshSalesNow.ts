/**
 * Tool: refresh_sales_now
 *
 * On-demand "today only" sync. Synchronously invokes the Heartland sync
 * Lambda with `trigger: 'today-only'`, which runs the slim
 * payments+tickets path (~3-8s) and writes today's `POS#DAILY#YYYY-MM-DD`
 * row to DynamoDB. After this returns, the caller can re-run
 * `get_sales_summary` for today and see the freshest data straight from
 * Heartland (rather than the 6h-stale cached rollup).
 *
 * The agent should call this tool BEFORE `get_sales_summary` whenever
 * the user asks about "today", "now", "currently", "right now", or the
 * current day's sales — anything that requires real-time data fresher
 * than the scheduled 6-hour sync window.
 *
 * Returns a JSON-stringified summary (`{ refreshedAt, durationMs,
 * paymentsScanned, ticketsScanned }` or `{ error }`).
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { ToolContext } from '../helpers';

const lambdaClient = new LambdaClient({ region: 'us-east-1' });
const SYNC_FN_NAME =
  process.env['HEARTLAND_SYNC_FN'] ?? 'foot-solutions-pos-sync';

export interface RefreshSalesNowArgs {
  // No inputs — the slim sync always covers today via the rolling
  // 35-day window inside syncPaymentsAndTickets.
}

export async function refreshSalesNow(
  _args: RefreshSalesNowArgs,
  _ctx: ToolContext
): Promise<string> {
  try {
    const start = Date.now();
    const out = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SYNC_FN_NAME,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ trigger: 'today-only' })),
      })
    );
    const durationMs = Date.now() - start;
    if (out.FunctionError) {
      return JSON.stringify({
        error: `Heartland sync failed: ${out.FunctionError}`,
        details: out.Payload
          ? new TextDecoder().decode(out.Payload as Uint8Array).slice(0, 500)
          : '',
      });
    }
    const payload = out.Payload
      ? new TextDecoder().decode(out.Payload as Uint8Array)
      : '{}';
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return JSON.stringify({
      refreshedAt: new Date().toISOString(),
      durationMs,
      result: parsed,
      note: 'Today\'s sales data is now refreshed from Heartland. Call get_sales_summary next to see the latest numbers.',
    });
  } catch (err) {
    return JSON.stringify({
      error: `refresh_sales_now failed: ${(err as Error).message}`,
    });
  }
}
