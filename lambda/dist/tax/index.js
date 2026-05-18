"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const uuid_1 = require("uuid");
const redact_1 = require("../shared/redact");
// ── AWS Clients ──────────────────────────────────────────────────────
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: 'us-east-1' });
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({ region: 'us-east-1' });
const TABLE_NAME = process.env.TABLE_NAME;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-2-lite-v1:0';
// ── Helpers ──────────────────────────────────────────────────────────
function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}
function buildTaxPrompt(data) {
    const mileageDeduction = data.vehicleMilesDriven * 0.70;
    const homeOfficeDeduction = Math.min(data.homeOfficeSqFt, 300) * 5;
    const qbiBase = data.totalRevenue -
        data.cogs -
        data.totalOperatingExpenses -
        data.royaltyFees -
        data.adFundContributions -
        data.leasePayments -
        data.section179Purchases;
    const qbiDeduction = Math.max(0, qbiBase * 0.2);
    return `You are a CPA tax analysis assistant specializing in Texas franchise businesses.

Analyze the following financial data for a ${data.entityType} operating in Denton County, Texas for tax year ${data.taxYear}.

## Financial Data
- Total Annual Revenue: $${data.totalRevenue.toLocaleString()}
- Cost of Goods Sold (COGS): $${data.cogs.toLocaleString()}
- Total Compensation Paid: $${data.totalCompensation.toLocaleString()}
- Total Operating Expenses: $${data.totalOperatingExpenses.toLocaleString()}
- Royalty Fees Paid: $${data.royaltyFees.toLocaleString()}
- Advertising Fund Contributions: $${data.adFundContributions.toLocaleString()}
- Lease/Rent Payments: $${data.leasePayments.toLocaleString()}
- Section 179 Equipment Purchases: $${data.section179Purchases.toLocaleString()}
- Business Vehicle Miles Driven: ${data.vehicleMilesDriven.toLocaleString()}
- Home Office Square Footage: ${data.homeOfficeSqFt}
- Owner Health Insurance Premiums: $${data.ownerHealthInsurance.toLocaleString()}
- Standards Applied: ${data.useStandards ? 'Yes' : 'No'}

## Applied Standard Rates (if standards enabled)
${data.useStandards
        ? `- IRS Mileage Rate: $0.70/mile → Deduction: $${mileageDeduction.toLocaleString()}
- Section 179 Limit: $1,160,000
- QBI Deduction (20% of qualified income): ~$${qbiDeduction.toLocaleString()}
- Home Office Rate: $5/sqft (max 300 sqft) → Deduction: $${homeOfficeDeduction.toLocaleString()}
- Denton County Sales Tax Rate: 8.25% (TX 6.25% + City of Denton 1.5% + DCTA 0.5%)
- Texas Franchise Tax Rate: 0.375%`
        : 'Not applied — user entered values manually.'}

## Texas Tax Context
- Texas Franchise Tax no-tax-due threshold: $2,470,000 annualized revenue
- Four Texas margin methods: (1) revenue minus COGS, (2) revenue minus compensation, (3) 70% of revenue, (4) revenue minus $1M
- Use the method that results in the lowest tax liability
- Texas franchise tax rate: 0.375% on the margin

## Federal Deduction Rules
- Royalty fees: fully deductible as ordinary business expense
- Advertising fund contributions: fully deductible
- Lease/rent payments: fully deductible
- Section 179: immediate expensing up to $1,160,000 for eligible equipment
- QBI Deduction: up to 20% of qualified business income for pass-through entities (LLC, S-Corp, Sole Proprietorship, Partnership)
- Franchise fee amortization: amortize over 15 years (Section 197 intangible)
- Owner health insurance: deductible for self-employed individuals

## Required Output Format
Respond ONLY with a valid JSON object matching this exact structure (no markdown, no explanation):
{
  "estimatedFederalTaxableIncome": <number>,
  "estimatedFederalTaxLiability": <number>,
  "estimatedTexasFranchiseTax": <number>,
  "texasMarginMethodUsed": "<revenue_minus_cogs|revenue_minus_compensation|70_percent_revenue|revenue_minus_1m>",
  "estimatedSalesTaxOwed": <number>,
  "keyDeductions": ["<deduction 1>", "<deduction 2>", ...],
  "flaggedForCPAReview": ["<item 1>", ...],
  "ownerSummary": "<plain English 2-3 sentence summary>",
  "disclaimer": "This is an estimate only based on the figures provided. Actual tax liability may differ. Consult a licensed CPA before filing."
}`;
}
async function invokeBedrock(prompt) {
    const payload = {
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text: prompt }],
            },
        ],
        inferenceConfig: {
            maxTokens: 2048,
            temperature: 0.1,
        },
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
    // Strip any accidental markdown code fences
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned);
}
// ── Route Handlers ───────────────────────────────────────────────────
async function handleCalculate(event, userId) {
    if (!event.body) {
        return json(400, { error: 'Request body is required' });
    }
    let inputData;
    try {
        inputData = JSON.parse(event.body);
    }
    catch {
        return json(400, { error: 'Invalid JSON in request body' });
    }
    // Validation
    if (!inputData.taxYear || inputData.taxYear < 2000 || inputData.taxYear > 2099) {
        return json(400, { error: 'taxYear must be a 4-digit year between 2000 and 2099', field: 'taxYear' });
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
    // Invoke Bedrock
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
    // Persist to DynamoDB
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
        await docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: item,
        }));
    }
    catch (err) {
        const error = err;
        console.error('DynamoDB write failed:', error.message);
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
            ExpressionAttributeValues: {
                ':uid': userId,
                ':prefix': 'TAX#',
            },
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
        const error = err;
        console.error('DynamoDB query failed:', error.message);
        return json(500, { error: 'Failed to retrieve tax history.' });
    }
}
async function handleGetSession(event, userId) {
    const sessionId = event.pathParameters?.id;
    if (!sessionId) {
        return json(400, { error: 'Session ID is required' });
    }
    try {
        const result = await docClient.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: {
                userId,
                sk: `TAX#${sessionId}`,
            },
        }));
        if (!result.Item) {
            return json(404, { error: 'Session not found' });
        }
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
        const error = err;
        console.error('DynamoDB get failed:', error.message);
        return json(500, { error: 'Failed to retrieve tax session.' });
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
        default:
            return json(404, { error: 'Route not found' });
    }
};
exports.handler = handler;
//# sourceMappingURL=index.js.map