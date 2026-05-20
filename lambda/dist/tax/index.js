"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const uuid_1 = require("uuid");
const redact_1 = require("../shared/redact");
const taxConstants_1 = require("../shared/taxConstants");
// ── AWS Clients ──────────────────────────────────────────────────────
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: 'us-east-1' });
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({ region: 'us-east-1' });
const TABLE_NAME = process.env['TABLE_NAME'];
const BEDROCK_MODEL_ID = process.env['BEDROCK_MODEL_ID'] ?? 'us.amazon.nova-2-lite-v1:0';
// ── Helpers ──────────────────────────────────────────────────────────
function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}
function fmtMoney(n) {
    if (n === undefined || n === null)
        return 'not provided';
    return `$${n.toLocaleString()}`;
}
function buildTaxPrompt(data) {
    return `You are an expert CPA tax assistant analyzing a small business tax return for tax year ${data.taxYear}. Your analysis must be accurate, compliant with current 2026 IRS and Texas tax law, and tailored to a Foot Solutions retail franchise location in Denton County, Texas.

## Business Profile
- Entity Type: ${data.entityType}
- Filing Status: ${data.filingStatus}
- Industry: Specialty retail footwear and orthotics (NAICS ${taxConstants_1.FOOT_SOLUTIONS.naicsCode})
- Location: Denton County, Texas
- Sole Owner: ${data.isSoleOwner ? 'Yes' : 'No'}
- Franchise: ${data.isFranchise ? 'Yes (Foot Solutions)' : 'No'}
- Retail Classification: ${data.isRetail ? 'Yes — qualifies for Texas reduced franchise tax rate' : 'No'}
- Multi-state operations: ${data.isMultiState ? 'Yes' : 'No'}

## Income & Cost of Goods Sold
- Total Annual Revenue: ${fmtMoney(data.totalRevenue)}
- Cost of Goods Sold: ${fmtMoney(data.cogs)}
- Beginning Inventory: ${fmtMoney(data.beginningInventory)}
- Ending Inventory: ${fmtMoney(data.endingInventory)}

## Operating Expenses
- Total Operating Expenses: ${fmtMoney(data.totalOperatingExpenses)}
- Rent / Lease: ${fmtMoney(data.rentLeasePayments)}
- Utilities: ${fmtMoney(data.utilities)}
- Business Insurance Premiums: ${fmtMoney(data.businessInsurancePremiums)}
- Professional Fees (legal/CPA): ${fmtMoney(data.professionalFees)}
- Marketing/Advertising: ${fmtMoney(data.marketingAdvertising)}
- Office Supplies: ${fmtMoney(data.officeSupplies)}
- Bank/Merchant Fees: ${fmtMoney(data.bankFees)}
- Software Subscriptions: ${fmtMoney(data.softwareSubscriptions)}

## Payroll
${data.hasEmployees
        ? `- Number of Employees: ${data.employeeCount ?? 0}
- Total Employee Wages (W-2): ${fmtMoney(data.totalEmployeeWages)}
- Employer Payroll Taxes (FICA + FUTA + SUTA): ${fmtMoney(data.employerPayrollTaxes)}
- Retirement Plan Contributions (employer match): ${fmtMoney(data.retirementPlanContributions)}
- Employer-Paid Employee Health Insurance: ${fmtMoney(data.employerHealthInsurance)}`
        : '- No W-2 employees'}

## Contractors
${data.hasContractors
        ? `- Total 1099-NEC Payments: ${fmtMoney(data.total1099Payments)}`
        : '- No 1099 contractors'}

## Business Vehicle
${data.hasBusinessVehicle
        ? `- Method: ${data.vehicleMethod === 'standard_mileage' ? 'Standard Mileage Rate' : 'Actual Expenses'}
- Business Miles Driven: ${(data.vehicleMilesDriven ?? 0).toLocaleString()}
- Business Use Percent: ${data.businessUsePercent ?? 100}%
- Standard Mileage Deduction (calculated): ${fmtMoney((data.vehicleMilesDriven ?? 0) * taxConstants_1.FEDERAL.standardMileageRate)}
${data.vehicleMethod === 'actual_expenses'
            ? `- Actual Vehicle Expenses: ${fmtMoney(data.actualVehicleExpenses)}`
            : ''}`
        : '- No business vehicle'}

## Home Office
${data.hasHomeOffice
        ? `- Method: ${data.homeOfficeMethod === 'simplified' ? 'Simplified ($5/sqft)' : 'Actual Expenses'}
- Home Office Square Footage: ${data.homeOfficeSqFt ?? 0}
- Total Home Square Footage: ${data.totalHomeSqFt ?? 0}
${data.homeOfficeMethod === 'simplified'
            ? `- Simplified Deduction (calculated): ${fmtMoney(Math.min(data.homeOfficeSqFt ?? 0, taxConstants_1.FEDERAL.homeOffice.simplifiedMaxSqFt) * taxConstants_1.FEDERAL.homeOffice.simplifiedRatePerSqFt)}`
            : `- Actual Home Office Expenses: ${fmtMoney(data.homeOfficeActualExpenses)}`}`
        : '- No home office'}

## Equipment & Depreciation
${data.hasEquipment
        ? `- Total Equipment Cost This Year: ${fmtMoney(data.totalEquipmentCost)}
- Section 179 Limit (2026): ${fmtMoney(taxConstants_1.FEDERAL.section179.maxDeduction)}
- Phase-out begins at: ${fmtMoney(taxConstants_1.FEDERAL.section179.phaseOutStart)}
- Bonus Depreciation: 100% permanent (OBBBA)
${data.fixedAssets && data.fixedAssets.length > 0
            ? `- Asset detail:\n${data.fixedAssets.map((a) => `  • ${a.description}: ${fmtMoney(a.cost)}, placed in service ${a.placedInServiceDate}, method: ${a.method}`).join('\n')}`
            : ''}`
        : '- No equipment purchases this year'}

## Franchise (Foot Solutions)
${data.isFranchise
        ? `- Royalty Rate (per FDD): ${(taxConstants_1.FOOT_SOLUTIONS.royaltyPercent * 100).toFixed(0)}% of gross sales — expected royalty for revenue of ${fmtMoney(data.totalRevenue)} is ${fmtMoney(data.totalRevenue * taxConstants_1.FOOT_SOLUTIONS.royaltyPercent)}
- Royalty Fees Paid: ${fmtMoney(data.royaltyFees)}
- Advertising Fund Contributions: ${fmtMoney(data.adFundContributions)}
- Initial Franchise Fee Paid This Year: ${fmtMoney(data.initialFranchiseFeePaidThisYear)} (amortize over ${taxConstants_1.FOOT_SOLUTIONS.initialFranchiseFeeAmortizationYears} years per Section 197)
- IF the user-reported royaltyFees deviates more than 10% from the expected ${(taxConstants_1.FOOT_SOLUTIONS.royaltyPercent * 100).toFixed(0)}% × revenue, flag it under "flaggedForCPAReview" with the discrepancy.`
        : ''}

## Business Loans
${data.hasBusinessLoans
        ? `- Loan Interest Paid (deductible): ${fmtMoney(data.loanInterestPaid)}
- Loan Principal Paid (NOT deductible): ${fmtMoney(data.loanPrincipalPaid)}`
        : '- No business loans'}

## Sales Tax (Texas Retail)
${data.isRetail
        ? `- Sales Tax Collected: ${fmtMoney(data.salesTaxCollected)}
- Sales Tax Remitted: ${fmtMoney(data.salesTaxRemitted)}
- Combined Denton Rate: ${(taxConstants_1.TEXAS.salesTax.combined * 100).toFixed(2)}% (TX ${(taxConstants_1.TEXAS.salesTax.state * 100).toFixed(2)}% + Denton ${(taxConstants_1.TEXAS.salesTax.cityOfDenton * 100).toFixed(2)}% + DCTA ${(taxConstants_1.TEXAS.salesTax.dctaTransit * 100).toFixed(2)}%)`
        : ''}

## Owner / Pass-Through Specifics
- Ownership Percent: ${data.ownershipPercent}%
- Owner Health Insurance Premiums: ${fmtMoney(data.ownerHealthInsurancePremiums)}
${data.entityType === 'S-Corp' ? `- Owner W-2 Compensation (S-Corp): ${fmtMoney(data.ownerCompensation)}` : ''}
${data.entityType === 'S-Corp' || data.entityType === 'Multi-Member LLC' || data.entityType === 'Partnership' ? `- Owner Distributions/Draws: ${fmtMoney(data.ownerDistributions)}` : ''}

${data.isMultiState && data.outOfStateRevenuePercent
        ? `## Multi-State Apportionment\n- Out-of-state Revenue Percent: ${data.outOfStateRevenuePercent}%`
        : ''}

## Standards Toggle
- Apply Standard Rates Automatically: ${data.useStandards ? 'YES — use the constants below' : 'NO — use only what the user provided'}

## CRITICAL 2026 TAX CONSTANTS (USE THESE EXACT VALUES)
### Federal (2026 — IRS Notice 2026-10 + OBBBA)
- IRS Standard Mileage Rate: $${taxConstants_1.FEDERAL.standardMileageRate}/mile
- Section 179 max deduction: ${fmtMoney(taxConstants_1.FEDERAL.section179.maxDeduction)} (phase-out at ${fmtMoney(taxConstants_1.FEDERAL.section179.phaseOutStart)})
- Bonus depreciation: 100% PERMANENT (OBBBA — applies to property placed in service after Jan 19, 2025)
- Section 199A QBI deduction: ${(taxConstants_1.FEDERAL.qbi.rate * 100).toFixed(0)}% (RAISED from 20% by OBBBA — now permanent)
- QBI thresholds (single): $${taxConstants_1.FEDERAL.qbi.thresholds.single.start.toLocaleString()}–$${taxConstants_1.FEDERAL.qbi.thresholds.single.end.toLocaleString()}
- QBI thresholds (MFJ): $${taxConstants_1.FEDERAL.qbi.thresholds.marriedFilingJointly.start.toLocaleString()}–$${taxConstants_1.FEDERAL.qbi.thresholds.marriedFilingJointly.end.toLocaleString()}
- Self-employment tax: 12.4% SS (up to $${taxConstants_1.FEDERAL.selfEmploymentTax.socialSecurityWageBase2026.toLocaleString()}) + 2.9% Medicare on all
- Additional Medicare 0.9% above $200K (single) / $250K (MFJ)
- Standard deduction: single $${taxConstants_1.FEDERAL.standardDeduction.single.toLocaleString()}, MFJ $${taxConstants_1.FEDERAL.standardDeduction.marriedFilingJointly.toLocaleString()}
- Section 197 (franchise fee amortization): 15 years
- Solo 401(k) employee max: $${taxConstants_1.FEDERAL.retirement.solo401kEmployee.toLocaleString()} (under 50)
- SEP-IRA: lesser of 25% of compensation or $${taxConstants_1.FEDERAL.retirement.sepIra.maxContribution.toLocaleString()}

### Texas (2026/2027 — TX Comptroller)
- Franchise tax no-tax-due threshold: ${fmtMoney(taxConstants_1.TEXAS.franchiseTax.noTaxDueThreshold)}
- Retail/wholesale rate: ${(taxConstants_1.TEXAS.franchiseTax.rateRetailWholesale * 100).toFixed(3)}%
- All other rate: ${(taxConstants_1.TEXAS.franchiseTax.rateOther * 100).toFixed(2)}%
- Compensation deduction cap per employee: ${fmtMoney(taxConstants_1.TEXAS.franchiseTax.compensationDeductionCap)}
- EZ Computation: ${(taxConstants_1.TEXAS.franchiseTax.ezComputation.rate * 100).toFixed(3)}% on revenue if total revenue ≤ ${fmtMoney(taxConstants_1.TEXAS.franchiseTax.ezComputation.revenueThreshold)}
- Four margin methods: (1) revenue minus COGS, (2) revenue minus compensation (capped at $${taxConstants_1.TEXAS.franchiseTax.compensationDeductionCap.toLocaleString()}/employee), (3) 70% of revenue, (4) revenue minus $1M
- Franchise tax annual report due: ${taxConstants_1.TEXAS.franchiseTax.annualReportDueDate}
- No state income tax for individuals or businesses
- Combined Denton sales tax rate: ${(taxConstants_1.TEXAS.salesTax.combined * 100).toFixed(2)}%

### Industry Benchmarks (NAICS ${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.naicsCode} — specialty footwear retail)
- Typical COGS: ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.cogsPercent.typical * 100).toFixed(0)}% of revenue (range ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.cogsPercent.low * 100).toFixed(0)}–${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.cogsPercent.high * 100).toFixed(0)}%)
- Typical rent: ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.rentPercent.typical * 100).toFixed(0)}% of revenue
- Typical payroll: ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.payrollPercent.typical * 100).toFixed(0)}% of revenue
- Reasonable comp range for full-time owner-operator S-Corp: $${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.reasonableCompFullTime.low.toLocaleString()}–$${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.reasonableCompFullTime.high.toLocaleString()}/year (median $${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.reasonableCompFullTime.median.toLocaleString()})

## Required Output Format
Return ONLY a valid JSON object with this exact structure (no markdown fences, no surrounding text):

{
  "estimatedFederalTaxableIncome": <number>,
  "estimatedFederalTaxLiability": <number>,
  "estimatedSelfEmploymentTax": <number>,
  "estimatedTexasFranchiseTax": <number>,
  "texasMarginMethodUsed": "<one of: revenue_minus_cogs | revenue_minus_compensation | 70_percent_revenue | revenue_minus_1m | ez_computation | no_tax_due>",
  "texasMarginMethodComparison": [
    {"method": "revenue_minus_cogs", "margin": <number>, "tax": <number>},
    {"method": "revenue_minus_compensation", "margin": <number>, "tax": <number>},
    {"method": "70_percent_revenue", "margin": <number>, "tax": <number>},
    {"method": "revenue_minus_1m", "margin": <number>, "tax": <number>}
  ],
  "estimatedSalesTaxOwed": <number>,
  "qbiDeduction": <number>,
  "estimatedQuarterlyPayments": [
    {"quarter": "Q1 2026", "dueDate": "April 15, 2026", "amount": <number>},
    {"quarter": "Q2 2026", "dueDate": "June 15, 2026", "amount": <number>},
    {"quarter": "Q3 2026", "dueDate": "September 15, 2026", "amount": <number>},
    {"quarter": "Q4 2026", "dueDate": "January 15, 2027", "amount": <number>}
  ],
  "keyDeductions": [
    "<deduction with $ amount>",
    "..."
  ],
  "taxSavingOpportunities": [
    "<specific actionable suggestion>",
    "..."
  ],
  "flaggedForCPAReview": [
    "<item that needs CPA attention>",
    "..."
  ],
  "formsToFile": [
    "<IRS or TX form number with brief description>",
    "..."
  ],
  "yearOverYearChanges": [
    "<note about 2026 changes vs 2025: OBBBA QBI 20%→23%, Section 179 doubled, mileage 70¢→72.5¢, TX no-tax-due $2.47M→$2.65M, etc.>"
  ],
  "ownerSummary": "<2-4 sentence plain-English summary the owner can read at a glance>",
  "disclaimer": "This is a Bedrock-generated estimate using current 2026 tax law (OBBBA + IRS Notice 2026-10 + TX Comptroller 2026/2027 schedule). Final tax liability requires CPA review and may vary based on items not captured in this form."
}

## Analysis Instructions
1. **Calculate Texas franchise tax** using ALL FOUR margin methods plus EZ Computation if applicable. Show the comparison and use the LOWEST tax. If revenue is below $${taxConstants_1.TEXAS.franchiseTax.noTaxDueThreshold.toLocaleString()}, the tax is $0 but a Public Information Report is still required.
2. **Calculate sales tax owed** as collected minus remitted (if both provided), or estimate as ${(taxConstants_1.TEXAS.salesTax.combined * 100).toFixed(2)}% × revenue if only revenue is known.
3. **Calculate federal taxable income** as revenue minus COGS minus operating expenses minus depreciation/Section 179 minus QBI deduction.
4. **Apply 23% QBI deduction** for tax year 2026 (OBBBA). Apply phase-out if income exceeds thresholds.
5. **Calculate self-employment tax** for sole proprietorships and single-member LLCs using 15.3% on 92.35% of net earnings (capped at SS wage base).
6. **For S-Corps:** flag if owner W-2 compensation is below $${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.reasonableCompFullTime.low.toLocaleString()} (audit risk) and recommend the median ($${taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.reasonableCompFullTime.median.toLocaleString()}). If owner takes large distributions but $0 W-2, flag as guaranteed audit risk.
7. **Quarterly payments:** total estimated annual liability ÷ 4, with adjustments if any current-year payments already made.
8. **Forms to file:** include the entity-specific federal forms (1040 Schedule C / 1120-S / 1065 / 8825), Form 4562 if any depreciation, Form 8995 or 8995-A for QBI, Schedule SE if self-employment tax, and TX 05-158/05-169/PIR for Texas.
9. **Year-over-year changes:** ALWAYS mention the OBBBA-driven changes (QBI 20%→23%, Section 179 doubled, bonus depreciation 100% permanent), the 2026 mileage rate increase to 72.5¢, and the TX no-tax-due threshold bump to $2.65M.
10. **Tax-saving opportunities:** suggest specific actions like retirement plan contributions (SEP-IRA up to 25% of compensation, Solo 401(k) up to $${taxConstants_1.FEDERAL.retirement.solo401kEmployee.toLocaleString()} employee + 25% employer), accelerating equipment purchases for 100% bonus depreciation, S-Corp election for self-employment tax savings, etc.
11. **Audit risk flags:** compare expense ratios against retail footwear benchmarks. Flag if COGS/revenue is outside ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.cogsPercent.low * 100).toFixed(0)}–${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.cogsPercent.high * 100).toFixed(0)}% range, rent outside ${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.rentPercent.low * 100).toFixed(0)}–${(taxConstants_1.RETAIL_FOOTWEAR_BENCHMARKS.expenseRatios.rentPercent.high * 100).toFixed(0)}%, or other ratios are unusually high/low.

Respond with ONLY the JSON object — no markdown, no commentary.`;
}
async function invokeBedrock(prompt) {
    const payload = {
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 4096, temperature: 0.1 },
    };
    const command = new client_bedrock_runtime_1.InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
    });
    const response = await Promise.race([
        bedrockClient.send(command),
        new Promise((_, reject) => setTimeout(() => reject(new Error('BEDROCK_TIMEOUT')), 29000)),
    ]);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    const text = body.output.message.content[0].text;
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
}
// ── Route Handlers ───────────────────────────────────────────────────
async function handleCalculate(event, userId) {
    if (!event.body)
        return json(400, { error: 'Request body is required' });
    let inputData;
    try {
        inputData = JSON.parse(event.body);
    }
    catch {
        return json(400, { error: 'Invalid JSON in request body' });
    }
    // Basic validation
    if (!inputData.taxYear || inputData.taxYear < 2000 || inputData.taxYear > 2099) {
        return json(400, { error: 'taxYear must be between 2000 and 2099', field: 'taxYear' });
    }
    if (inputData.totalRevenue === undefined || inputData.totalRevenue < 0) {
        return json(400, { error: 'totalRevenue is required and must be non-negative', field: 'totalRevenue' });
    }
    if (inputData.cogs === undefined || inputData.cogs < 0) {
        return json(400, { error: 'cogs is required and must be non-negative', field: 'cogs' });
    }
    if (!inputData.entityType) {
        return json(400, { error: 'entityType is required', field: 'entityType' });
    }
    console.log('Tax calculation request:', JSON.stringify((0, redact_1.redact)(inputData)));
    const sessionId = (0, uuid_1.v4)();
    const createdAt = new Date().toISOString();
    let bedrockResponse;
    try {
        const prompt = buildTaxPrompt(inputData);
        bedrockResponse = await invokeBedrock(prompt);
    }
    catch (err) {
        const error = err;
        if (error.message === 'BEDROCK_TIMEOUT') {
            console.error('Bedrock invocation timed out');
            return json(504, { error: 'Tax analysis timed out. Please try again.' });
        }
        console.error('Bedrock invocation failed:', error.message);
        return json(502, { error: 'AI model returned an unexpected response. Please try again.' });
    }
    const item = {
        userId,
        sk: `TAX#${sessionId}`,
        sessionId,
        taxYear: inputData.taxYear,
        entityType: inputData.entityType,
        inputData: (0, redact_1.redact)(inputData),
        useStandards: inputData.useStandards,
        bedrockResponse,
        createdAt,
        status: 'complete',
    };
    try {
        await docClient.send(new lib_dynamodb_1.PutCommand({ TableName: TABLE_NAME, Item: item }));
    }
    catch (err) {
        console.error('DynamoDB write failed:', err.message);
        return json(500, { error: 'Failed to save tax session. Please try again.' });
    }
    return json(200, {
        sessionId,
        taxYear: inputData.taxYear,
        createdAt,
        result: bedrockResponse,
    });
}
async function handleListHistory(userId) {
    try {
        const result = await docClient.send(new lib_dynamodb_1.QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':uid': userId, ':prefix': 'TAX#' },
            ScanIndexForward: false,
            Limit: 100,
            ProjectionExpression: 'sessionId, taxYear, entityType, createdAt, #s',
            ExpressionAttributeNames: { '#s': 'status' },
        }));
        const sessions = (result.Items ?? []).map((item) => ({
            sessionId: item['sessionId'],
            taxYear: item['taxYear'],
            entityType: item['entityType'],
            createdAt: item['createdAt'],
            status: item['status'],
        }));
        return json(200, { sessions });
    }
    catch (err) {
        console.error('DynamoDB query failed:', err.message);
        return json(500, { error: 'Failed to retrieve tax history.' });
    }
}
async function handleGetSession(event, userId) {
    const sessionId = event.pathParameters?.['id'];
    if (!sessionId)
        return json(400, { error: 'Session ID is required' });
    try {
        const result = await docClient.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { userId, sk: `TAX#${sessionId}` },
        }));
        if (!result.Item)
            return json(404, { error: 'Session not found' });
        const item = result.Item;
        return json(200, {
            sessionId: item['sessionId'],
            taxYear: item['taxYear'],
            entityType: item['entityType'],
            createdAt: item['createdAt'],
            status: item['status'],
            useStandards: item['useStandards'],
            inputData: item['inputData'],
            result: item['bedrockResponse'],
        });
    }
    catch (err) {
        console.error('DynamoDB get failed:', err.message);
        return json(500, { error: 'Failed to retrieve tax session.' });
    }
}
async function handleDeleteSession(event, userId) {
    const sessionId = event.pathParameters?.['id'];
    if (!sessionId)
        return json(400, { error: 'Session ID is required' });
    try {
        // Verify the session exists and belongs to the user before deleting.
        const existing = await docClient.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { userId, sk: `TAX#${sessionId}` },
        }));
        if (!existing.Item)
            return json(404, { error: 'Session not found' });
        await docClient.send(new lib_dynamodb_1.DeleteCommand({
            TableName: TABLE_NAME,
            Key: { userId, sk: `TAX#${sessionId}` },
        }));
        return json(200, { sessionId, deleted: true });
    }
    catch (err) {
        console.error('DynamoDB delete failed:', err.message);
        return json(500, { error: 'Failed to delete tax session.' });
    }
}
// ── Main Handler ─────────────────────────────────────────────────────
const handler = async (event) => {
    const userId = event.requestContext.authorizer.jwt.claims['sub'];
    switch (event.routeKey) {
        case 'POST /tax/calculate':
            return handleCalculate(event, userId);
        case 'GET /tax/history':
            return handleListHistory(userId);
        case 'GET /tax/history/{id}':
            return handleGetSession(event, userId);
        case 'DELETE /tax/history/{id}':
            return handleDeleteSession(event, userId);
        default:
            return json(404, { error: 'Route not found' });
    }
};
exports.handler = handler;
//# sourceMappingURL=index.js.map