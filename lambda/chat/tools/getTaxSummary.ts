/**
 * Tool: get_tax_summary
 *
 * Most recent CPA tax analysis session for the caller — form inputs and
 * AI-estimated results.
 *
 * Lifted verbatim from `case 'get_tax_summary':` in
 * `lambda/chat/index.ts`. No behaviour change.
 *
 * Note: tax sessions are stored under the authenticated caller's own
 * Cognito sub, NOT `OWNER_USER_ID`. Falls back to `ownerUserId` if no
 * caller id is provided (preserving legacy behaviour).
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ToolContext } from '../helpers';

export interface GetTaxSummaryArgs {
  tax_year?: string;
}

export async function getTaxSummary(
  args: GetTaxSummaryArgs,
  ctx: ToolContext
): Promise<string> {
  // Tax sessions are stored under the authenticated user's own sub, not OWNER_USER_ID
  const taxUserId = ctx.callerUserId ?? ctx.ownerUserId;
  const taxYearFilter = args.tax_year;
  // Query all tax sessions for this user, sorted by most recent
  const result = await ctx.docClient.send(new QueryCommand({
    TableName: ctx.tableName,
    KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':uid': taxUserId, ':prefix': 'TAX#' },
    ScanIndexForward: false, // newest first
    Limit: 10,
  }));
  const sessions = (result.Items ?? []).filter(item => {
    if (!taxYearFilter) return true;
    return String(item['taxYear'] ?? '') === taxYearFilter;
  });
  if (sessions.length === 0) {
    return JSON.stringify({
      error: taxYearFilter
        ? `No tax session found for ${taxYearFilter}`
        : 'No tax sessions found. Run a tax analysis first.',
    });
  }
  const latest = sessions[0]!;
  const inputData = latest['inputData'] as Record<string, unknown> | undefined;
  const result2 = latest['result'] as Record<string, unknown> | undefined;
  return JSON.stringify({
    sessionId: latest['sessionId'],
    taxYear: latest['taxYear'],
    entityType: latest['entityType'],
    createdAt: latest['createdAt'],
    status: latest['status'],
    formInputs: inputData ? {
      totalRevenue: inputData['totalRevenue'],
      cogs: inputData['cogs'],
      totalOperatingExpenses: inputData['totalOperatingExpenses'],
      rentLeasePayments: inputData['rentLeasePayments'],
      totalEmployeeWages: inputData['totalEmployeeWages'],
      royaltyFees: inputData['royaltyFees'],
      adFundContributions: inputData['adFundContributions'],
      businessInsurancePremiums: inputData['businessInsurancePremiums'],
      loanInterestPaid: inputData['loanInterestPaid'],
      salesTaxCollected: inputData['salesTaxCollected'],
      ownerHealthInsurancePremiums: inputData['ownerHealthInsurancePremiums'],
      hasEmployees: inputData['hasEmployees'],
      employeeCount: inputData['employeeCount'],
      isFranchise: inputData['isFranchise'],
    } : null,
    estimates: result2 ? {
      estimatedFederalTaxableIncome: result2['estimatedFederalTaxableIncome'],
      estimatedFederalTaxLiability: result2['estimatedFederalTaxLiability'],
      estimatedSelfEmploymentTax: result2['estimatedSelfEmploymentTax'],
      estimatedTexasFranchiseTax: result2['estimatedTexasFranchiseTax'],
      qbiDeduction: result2['qbiDeduction'],
      estimatedQuarterlyPayments: result2['estimatedQuarterlyPayments'],
      keyDeductions: result2['keyDeductions'],
      flaggedForCPAReview: result2['flaggedForCPAReview'],
      formsToFile: result2['formsToFile'],
      ownerSummary: result2['ownerSummary'],
    } : null,
  });
}
