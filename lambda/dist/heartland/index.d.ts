/**
 * Heartland Retail POS integration Lambda — user-facing read-only handler.
 *
 * All Heartland API calls happen in the `foot-solutions-pos-sync` Lambda
 * (scheduled every 6h via EventBridge). This handler only reads from the
 * DynamoDB cache, so every endpoint responds in well under 500ms.
 *
 * Routes:
 *   GET /pos/dashboard           → today / WTD / MTD / YTD revenue snapshot
 *   GET /pos/sales?year=2026     → sum of all payments in a year
 *   GET /pos/import-tax-defaults?taxYear=2026
 *                                → returns ready-to-merge TaxFormData fields
 *   GET /pos/analytics?days=90   → daily trend, payment methods, top customers,
 *                                   hourly heatmap, discount analysis
 *   GET /pos/inventory           → cached item catalog with cost/price/margin
 *   GET /pos/staff               → sales by rep from cached rollups
 *   GET /pos/sync-status         → last sync info (when, durations, counts)
 *   POST /pos/sync               → trigger a manual sync (async, returns 202)
 */
import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2>;
//# sourceMappingURL=index.d.ts.map