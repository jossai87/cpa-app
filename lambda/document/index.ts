import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({ region: 'us-east-1' });
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const DOCS_BUCKET = process.env['DOCS_BUCKET'] ?? '';
const TABLE_NAME = process.env['TABLE_NAME'] ?? '';
const NOVA_LITE_MODEL_ID =
  process.env['BEDROCK_MODEL_ID'] ?? 'us.amazon.nova-2-lite-v1:0';
const NOVA_PRO_MODEL_ID =
  process.env['BEDROCK_PRO_MODEL_ID'] ?? 'us.amazon.nova-pro-v1:0';

/**
 * Pick the right Bedrock model for the doc type.
 * - Nova 2 Lite: cheap + fast, good for simple structured docs.
 * - Nova Pro: smarter, less likely to hallucinate on dense/ambiguous docs.
 */
function pickModel(docType: string, isAutoClassify: boolean): string {
  // Auto-classify always uses Pro since we don't yet know what we're looking at
  if (isAutoClassify) return NOVA_PRO_MODEL_ID;

  const proDocTypes = new Set([
    'lease',
    'line-of-credit',
    'bank-statement',
    'profit-loss',
    'general',
  ]);
  return proDocTypes.has(docType) ? NOVA_PRO_MODEL_ID : NOVA_LITE_MODEL_ID;
}

// ── Helpers ──────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
];

function inferContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'csv':
      return 'text/csv';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

const ALLOWED_DOC_TYPES = [
  'auto',
  'profit-loss',
  'bank-statement',
  'line-of-credit',
  'payroll-summary',
  'royalty-statement',
  'sales-tax-return',
  'fixed-assets',
  'insurance',
  'lease',
  'general',
];

// ── POST /documents/upload-url ───────────────────────────────────────

async function handleUploadUrl(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'Request body is required' });

  let body: { fileName?: string; contentType?: string; docType?: string };
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON in request body' });
  }

  if (!body.fileName) {
    return json(400, { error: 'fileName is required' });
  }

  // Infer content-type from extension if browser didn't supply one.
  // Some xlsx files come through with an empty type from the browser.
  const inferred = inferContentType(body.fileName);
  const contentType = body.contentType && body.contentType !== ''
    ? body.contentType
    : inferred;

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return json(400, {
      error: `Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG`,
    });
  }

  const docType = ALLOWED_DOC_TYPES.includes(body.docType ?? '')
    ? body.docType
    : 'general';
  const objectKey = `${userId}/${docType}/${Date.now()}-${uuidv4()}-${body.fileName}`;

  try {
    // IMPORTANT: do NOT include ContentType or ServerSideEncryption in the
    // signed URL. They become signature-required headers, and the slightest
    // browser difference (e.g. xlsx files with empty `file.type`) returns 403.
    // Bucket-level encryption is already enforced via BucketEncryption.S3_MANAGED.
    const command = new PutObjectCommand({
      Bucket: DOCS_BUCKET,
      Key: objectKey,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300, // 5 minutes
    });

    return json(200, {
      uploadUrl,
      objectKey,
      docType,
      contentType,
      expiresIn: 300,
    });
  } catch (err) {
    console.error('Failed to create pre-signed URL:', (err as Error).message);
    return json(500, { error: 'Failed to create upload URL' });
  }
}

// ── POST /documents/extract ──────────────────────────────────────────
// Reads the uploaded document from S3 and uses Bedrock to extract
// structured tax data that can pre-populate the form fields.

async function handleExtract(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'Request body is required' });

  let body: { objectKey?: string; docType?: string; fileName?: string };
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON in request body' });
  }

  if (!body.objectKey) {
    return json(400, { error: 'objectKey is required' });
  }

  // Verify the object key starts with this user's prefix (path traversal guard)
  if (!body.objectKey.startsWith(`${userId}/`)) {
    return json(403, { error: 'Access denied to this document' });
  }

  // Fetch the document content from S3
  let documentBytes: Uint8Array;
  let contentType: string;
  let documentText: string | null = null;
  try {
    const getResult = await s3Client.send(
      new GetObjectCommand({
        Bucket: DOCS_BUCKET,
        Key: body.objectKey,
      })
    );

    contentType = getResult.ContentType ?? 'application/octet-stream';
    // If S3 stored a generic content type (object uploaded without one),
    // infer from the original filename embedded in the object key.
    if (
      contentType === 'application/octet-stream' ||
      contentType === 'binary/octet-stream'
    ) {
      const inferred = inferContentType(body.objectKey);
      if (inferred !== 'application/octet-stream') {
        contentType = inferred;
      }
    }
    documentBytes = await getResult.Body!.transformToByteArray();

    // Hard size cap — bigger files take Bedrock too long and API Gateway times out at 30s.
    // 8MB covers most real business docs (statements, leases, policies); textbook-sized PDFs get rejected early.
    if (documentBytes.byteLength > 8 * 1024 * 1024) {
      return json(413, {
        error:
          `Document is too large for AI extraction (${Math.round(documentBytes.byteLength / 1024 / 1024)}MB). ` +
          `Files must be under 8MB. For large reference documents, store them outside this app.`,
      });
    }

    // Text-based: read as UTF-8 and truncate
    if (contentType === 'text/csv' || contentType.startsWith('text/')) {
      documentText = new TextDecoder().decode(documentBytes);
      if (documentText.length > 50_000) {
        documentText = documentText.slice(0, 50_000) + '\n\n... [truncated]';
      }
    }
    // PDF / image: keep as bytes for multimodal Bedrock call
  } catch (err) {
    console.error('Failed to read document from S3:', (err as Error).message);
    return json(500, { error: 'Failed to read uploaded document' });
  }

  // Helper: build the multimodal content array (document/image + prompt text).
  // We may build this twice: once for classification, once for extraction.
  // Uses the Bedrock Converse API content block shapes (bytes as Uint8Array).
  type ConverseContent =
    | { text: string }
    | {
        document: {
          format: 'pdf' | 'csv' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'html' | 'txt' | 'md';
          name: string;
          source: { bytes: Uint8Array };
        };
      }
    | {
        image: {
          format: 'png' | 'jpeg' | 'gif' | 'webp';
          source: { bytes: Uint8Array };
        };
      };

  function buildContent(promptText: string): ConverseContent[] {
    const c: ConverseContent[] = [];
    const docName = 'uploaded-document'; // safe per DocumentBlock naming rules
    if (contentType === 'application/pdf') {
      c.push({
        document: { format: 'pdf', name: docName, source: { bytes: documentBytes } },
      });
    } else if (
      contentType === 'image/png' ||
      contentType === 'image/jpeg' ||
      contentType === 'image/jpg'
    ) {
      const fmt = contentType === 'image/png' ? 'png' : 'jpeg';
      c.push({
        image: { format: fmt, source: { bytes: documentBytes } },
      });
    } else if (
      contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      c.push({
        document: { format: 'xlsx', name: docName, source: { bytes: documentBytes } },
      });
    } else if (contentType === 'application/vnd.ms-excel') {
      c.push({
        document: { format: 'xls', name: docName, source: { bytes: documentBytes } },
      });
    } else if (
      contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      c.push({
        document: { format: 'docx', name: docName, source: { bytes: documentBytes } },
      });
    } else if (contentType === 'application/msword') {
      c.push({
        document: { format: 'doc', name: docName, source: { bytes: documentBytes } },
      });
    }
    // CSV/text: prompt embeds the text directly
    c.push({ text: promptText });
    return c;
  }

  async function callBedrock(
    content: ConverseContent[],
    maxTokens: number,
    modelId: string
  ): Promise<string> {
    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: content as never }],
      inferenceConfig: { maxTokens, temperature: 0.0 },
    });

    // Race against a 25-second timeout. API Gateway HTTP API integration cap is 30s, and
    // we need a few seconds for S3 fetch + DynamoDB write on either side of this call.
    const response = await Promise.race([
      bedrockClient.send(command),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('BEDROCK_TIMEOUT')), 25_000)
      ),
    ]);
    const text = response.output?.message?.content?.[0]?.text;
    if (!text) {
      throw new Error('Bedrock returned no text content');
    }
    return text;
  }

  // ── Auto-classify + extract in a SINGLE Bedrock call when docType is 'auto' ──
  let docType = body.docType ?? 'auto';
  let autoClassifyResult: {
    classifiedAs: string;
    confidence: 'high' | 'medium' | 'low';
    rationale: string;
    bestGuessLabel?: string;
  } | null = null;
  let extracted: Record<string, unknown> | null = null;

  if (docType === 'auto') {
    try {
      const combinedPrompt = buildClassifyAndExtractPrompt(documentText);
      // Auto-classify: use Nova Pro for accuracy across unknown doc types
      const rawText = await callBedrock(
        buildContent(combinedPrompt),
        4096,
        pickModel('auto', true)
      );
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      const parsed = JSON.parse(cleaned) as {
        classifiedAs: string;
        classifyConfidence: 'high' | 'medium' | 'low';
        classifyRationale: string;
        bestGuessLabel?: string;
        extracted: Record<string, unknown>;
      };

      autoClassifyResult = {
        classifiedAs: parsed.classifiedAs,
        confidence: parsed.classifyConfidence,
        rationale: parsed.classifyRationale,
        ...(parsed.bestGuessLabel && { bestGuessLabel: parsed.bestGuessLabel }),
      };

      const knownTypes = [
        'profit-loss',
        'bank-statement',
        'line-of-credit',
        'payroll-summary',
        'royalty-statement',
        'sales-tax-return',
        'fixed-assets',
        'insurance',
        'lease',
      ];
      if (
        parsed.classifyConfidence === 'low' ||
        !knownTypes.includes(parsed.classifiedAs)
      ) {
        docType = 'general';
      } else {
        docType = parsed.classifiedAs;
      }

      extracted = parsed.extracted ?? {};
    } catch (err) {
      const error = err as Error;
      if (error.message === 'BEDROCK_TIMEOUT') {
        console.error('Bedrock auto-classify timed out');
        return json(504, {
          error:
            'AI processing timed out. This document may be too long or complex. Try a smaller file or pick the document type manually.',
        });
      }
      console.warn(
        'Auto classify+extract failed, falling back to general:',
        error.message
      );
      docType = 'general';
      extracted = null; // will run a separate extract pass below
    }
  }

  // If we still need to run extraction (manual docType OR auto fallback), do it now
  if (extracted === null) {
    const promptText = buildExtractionPrompt(docType, documentText);
    const content = buildContent(promptText);
    try {
      const isStatement = docType === 'bank-statement' || docType === 'line-of-credit';
      const modelId = pickModel(docType, false);
      const rawText = await callBedrock(content, isStatement ? 4096 : 2048, modelId);
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      extracted = JSON.parse(cleaned);
    } catch (err) {
      const error = err as Error;
      if (error.message === 'BEDROCK_TIMEOUT') {
        console.error('Bedrock extraction timed out');
        return json(504, {
          error:
            'AI extraction timed out. This document may be too long. Try a smaller file or split it into pages.',
        });
      }
      console.error('Extraction failed:', error.message);
      return json(502, { error: 'Failed to extract data from document' });
    }
  }

  // Persist the upload record so the user can see it in the documents sidebar
  const docId = uuidv4();
  const uploadedAt = new Date().toISOString();
  // Derive a clean fileName: prefer the one passed in, otherwise reverse-derive from the
  // objectKey (which is `userId/docType/<timestamp>-<uuid>-<original>`)
  const derivedFileName =
    body.fileName ||
    body.objectKey.split('/').pop()?.replace(/^\d+-[0-9a-f-]+-/, '') ||
    'document';

  // Pull the categorized totals (for bank/LOC) or single-figure extraction.
  // We apply values regardless of confidence; the doc-level confidence is
  // preserved so the frontend can show a color-coded badge per field. The
  // user can edit/delete any value — low confidence is a hint, not a block.
  if (extracted === null) {
    // Should not happen — defensive guard
    return json(502, { error: 'Extraction returned no data' });
  }
  const ext: Record<string, unknown> = extracted;
  const isStatement =
    docType === 'bank-statement' || docType === 'line-of-credit';
  const isLowConfidence = ext['confidence'] === 'low';

  const appliedTotals = isStatement
    ? (ext['categoryTotals'] as Record<string, number> | undefined) ?? {}
    : Object.fromEntries(
        Object.entries(ext).filter(
          ([, v]) => typeof v === 'number' && (v as number) > 0
        )
      );

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId,
          sk: `DOC#${uploadedAt}#${docId}`,
          docId,
          objectKey: body.objectKey,
          fileName: derivedFileName,
          docType,
          contentType,
          uploadedAt,
          appliedTotals,
          flagged: ext['flaggedTransactions'] ?? [],
          bankName: ext['bankName'] ?? null,
          periodStart: ext['periodStart'] ?? null,
          periodEnd: ext['periodEnd'] ?? null,
          confidence: ext['confidence'] ?? null,
          notes: ext['notes'] ?? null,
          autoClassified: autoClassifyResult !== null,
          autoClassifyResult: autoClassifyResult ?? null,
        },
      })
    );
  } catch (err) {
    console.error('Failed to persist document record:', (err as Error).message);
    // Don't fail the request — the user still gets the extraction result
  }

  return json(200, {
    docId,
    objectKey: body.objectKey,
    fileName: derivedFileName,
    docType,
    contentType,
    uploadedAt,
    extracted: ext,
    autoClassifyResult,
    isLowConfidence,
  });
}

function buildClassifyAndExtractPrompt(csvContent: string | null): string {
  const csvBlock = csvContent
    ? `\n## Document Content (CSV)\n\`\`\`\n${csvContent}\n\`\`\``
    : '';

  return `You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

## CRITICAL — DO NOT HALLUCINATE
- Only extract figures that are CLEARLY VISIBLE in the document.
- If a number is not present, return null. Never guess. Never make up numbers.
- If the document is unrelated to small-business finance (e.g., a textbook, an ethics manual, an article, marketing material), classify it as "general" with confidence "low" and return an empty extracted object: \`{"extractedFromDocType":"general","confidence":"low","notes":"<brief description of what this document actually is>"}\`.
- Do NOT fill in placeholder or example numbers (1234567, 78901, etc.). If unsure, return null.

Step 1 — CLASSIFY the attached business document into ONE category:

- profit-loss          → P&L statement, income statement
- bank-statement       → business checking/savings monthly statement
- line-of-credit       → line of credit, business loan, or credit-card revolving statement
- payroll-summary      → payroll run, W-2 summary, 941 quarterly, payroll annual report
- royalty-statement    → Foot Solutions corporate royalty/ad fund report
- sales-tax-return     → Texas sales tax return / WebFile confirmation
- fixed-assets         → depreciation schedule, fixed asset register
- insurance            → commercial insurance policy/quote (general liability, workers comp, umbrella) — NOT health/life
- lease                → commercial lease agreement
- general              → none of the above

Step 2 — EXTRACT structured tax data based on the category you chose. The extraction rules per category:

**bank-statement / line-of-credit:** classify every transaction line and aggregate by tax category. Use this exact \`extracted\` shape:
{
  "statementType": "business-checking|line-of-credit|unknown",
  "bankName": "<or null>",
  "accountLast4": "<or null>",
  "periodStart": "<YYYY-MM-DD or null>",
  "periodEnd": "<YYYY-MM-DD or null>",
  "categoryTotals": {
    "rentLeasePayments": <num>, "utilities": <num>, "businessInsurancePremiums": <num>,
    "professionalFees": <num>, "marketingAdvertising": <num>, "officeSupplies": <num>,
    "softwareSubscriptions": <num>, "bankFees": <num>, "royaltyFees": <num>,
    "adFundContributions": <num>, "loanInterestPaid": <num>, "loanPrincipalPaid": <num>,
    "totalEmployeeWages": <num>, "employerHealthInsurance": <num>, "total1099Payments": <num>,
    "totalEquipmentCost": <num>, "ownerHealthInsurancePremiums": <num>
  },
  "flaggedTransactions": [{"date":"YYYY-MM-DD","description":"<>","amount":<n>,"reason":"<>","bestGuessField":"<key|null>","guessConfidence":"high|medium|low"}],
  "totalDeposits": <num>, "totalWithdrawals": <num>,
  "confidence": "high|medium|low",
  "notes": "<short>"
}

Skip transfers, owner draws, sales tax remittances, and credit card payoff transactions. Foot Solutions Royalty → royaltyFees. Foot Solutions Ad Fund → adFundContributions. Heartland/Global Payments processing fees → bankFees.

**lease:** Use this exact \`extracted\` shape — \`rentLeasePayments\` MUST be the annual base rent (multiply monthly × 12 if needed), and \`notes\` describes lease term/dates/escalation:
{
  "rentLeasePayments": <annual rent in dollars>,
  "extractedFromDocType": "lease",
  "confidence": "high|medium|low",
  "notes": "<lease term, start/end dates, security deposit, escalation, CAM>"
}
Do NOT include security deposit in rentLeasePayments. If the lease has escalating rent across years, use the rent for the CURRENT calendar year (2026).

**insurance:** Use this exact \`extracted\` shape:
{
  "businessInsurancePremiums": <total annual premium>,
  "extractedFromDocType": "insurance",
  "confidence": "high|medium|low",
  "notes": "<short caveat>"
}

**profit-loss:** Use this \`extracted\` shape with whatever fields you can find (null for missing):
{
  "totalRevenue": <num|null>, "cogs": <num|null>, "totalOperatingExpenses": <num|null>,
  "rentLeasePayments": <num|null>, "utilities": <num|null>, "businessInsurancePremiums": <num|null>,
  "marketingAdvertising": <num|null>, "professionalFees": <num|null>, "totalEmployeeWages": <num|null>,
  "extractedFromDocType": "profit-loss", "confidence": "high|medium|low", "notes": "<>"
}

**royalty-statement:** \`{"totalRevenue": <num>, "royaltyFees": <num>, "adFundContributions": <num>, "extractedFromDocType":"royalty-statement", "confidence":"...", "notes":"<>"}\`

**sales-tax-return:** \`{"totalRevenue": <num>, "salesTaxCollected": <num>, "salesTaxRemitted": <num>, "extractedFromDocType":"sales-tax-return", "confidence":"...", "notes":"<>"}\`

**payroll-summary:** \`{"totalEmployeeWages": <num>, "employerPayrollTaxes": <num>, "employeeCount": <num>, "retirementPlanContributions": <num>, "employerHealthInsurance": <num>, "extractedFromDocType":"payroll-summary", "confidence":"...", "notes":"<>"}\`

**fixed-assets:** \`{"totalEquipmentCost": <num>, "extractedFromDocType":"fixed-assets", "confidence":"...", "notes":"<>"}\`

**general:** Best-effort extraction — \`{"extractedFromDocType":"general", "confidence":"...", "notes":"<what the document is and what figures could be found>"}\`

## Output Format
Return ONLY a JSON object, no markdown:

{
  "classifiedAs": "<one of the categories>",
  "classifyConfidence": "high|medium|low",
  "classifyRationale": "<one short sentence>",
  "bestGuessLabel": "<2-4 word label, e.g. 'Lease Agreement', 'Frost Bank Statement'>",
  "extracted": <the appropriate object for the category — see rules above>
}

All money values as plain numbers (no $, no commas, no cents).${csvBlock}`;
}

function buildExtractionPrompt(docType: string, csvContent: string | null): string {
  // Bank statement and line of credit docs need a totally different prompt
  // — they classify every transaction line, not extract a single number.
  if (docType === 'bank-statement' || docType === 'line-of-credit') {
    return buildBankStatementPrompt(docType, csvContent);
  }

  const docTypeDescriptions: Record<string, string> = {
    'profit-loss':
      'Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.',
    'payroll-summary':
      'Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.',
    'royalty-statement':
      'Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.',
    'sales-tax-return':
      'Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.',
    'fixed-assets':
      'Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.',
    insurance:
      'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability — sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',
    lease:
      'Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent — multiply monthly rent × 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year ' +
      new Date().getFullYear() +
      '. Do NOT include the security deposit or one-time fees in rentLeasePayments.',
    general:
      'Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums.',
  };

  const description =
    docTypeDescriptions[docType] ?? docTypeDescriptions['general'];

  const csvBlock = csvContent
    ? `\n## Document Content (CSV)\n\`\`\`\n${csvContent}\n\`\`\``
    : '';

  return `You are extracting structured tax data from a ${docType} document for a Foot Solutions retail franchise in Denton County, Texas.

## CRITICAL — DO NOT HALLUCINATE
- Only extract figures that are CLEARLY VISIBLE in the document.
- If a number is not present, return null. Never guess. Never make up numbers.
- Do NOT fill in placeholder or example numbers (1234567, 78901, etc.).
- If the document does not actually appear to be a ${docType}, set "confidence" to "low" and return null for all fields with a note explaining what the document actually is.

${description}
${csvBlock}

## Output Format
Return ONLY a valid JSON object with the extracted fields. Use null for fields you cannot determine. All monetary values as plain numbers (no $ or commas, no cents). Example:

{
  "totalRevenue": 280000,
  "cogs": 200000,
  "businessInsurancePremiums": 4250,
  "rentLeasePayments": null,
  "extractedFromDocType": "${docType}",
  "confidence": "high|medium|low",
  "notes": "<brief caveat or what was missing>"
}

Respond with ONLY the JSON object — no markdown fences, no explanation.`;
}

function buildBankStatementPrompt(
  docType: string,
  csvContent: string | null
): string {
  const isLOC = docType === 'line-of-credit';
  const csvBlock = csvContent
    ? `\n## Statement Content (CSV/text)\n\`\`\`\n${csvContent}\n\`\`\``
    : '';

  return `You are a CPA's automated bookkeeping assistant analyzing a ${
    isLOC ? 'business line of credit' : 'business checking'
  } statement for a Foot Solutions retail franchise in Denton County, Texas.

Classify EVERY transaction in this statement and aggregate by tax category.

## Tax Categories (these MUST be the exact keys in the output)

| Key | What goes here |
|---|---|
| ${'`rentLeasePayments`'} | Store rent, equipment leases, real estate lease |
| ${'`utilities`'} | Electric, gas, water, internet, phone, garbage |
| ${'`businessInsurancePremiums`'} | General liability, commercial property, workers comp, umbrella (NOT owner's personal health/life) |
| ${'`professionalFees`'} | Legal, CPA, bookkeeping, business consulting |
| ${'`marketingAdvertising`'} | Local ads, social media, Google Ads, signage, sponsorships, print (NOT franchisor ad fund) |
| ${'`officeSupplies`'} | Pens, paper, packaging, small consumables |
| ${'`softwareSubscriptions`'} | SaaS — POS subscription, QuickBooks, Microsoft 365, etc. |
| ${'`bankFees`'} | Account fees, overdraft fees, wire fees, ACH fees |
| ${'`royaltyFees`'} | Foot Solutions corporate royalty payments |
| ${'`adFundContributions`'} | Foot Solutions national ad fund |
| ${'`loanInterestPaid`'} | Interest portion of loan / line of credit payments |
| ${'`loanPrincipalPaid`'} | Principal portion of loan / line of credit payments (informational, NOT deductible) |
| ${'`totalEmployeeWages`'} | Direct deposit / payroll runs to employees |
| ${'`employerHealthInsurance`'} | Health insurance premium payments for employees |
| ${'`total1099Payments`'} | Payments to independent contractors |
| ${'`totalEquipmentCost`'} | Major equipment purchases (foot scanners, 3D printers, POS hardware, furniture > $500) |
| ${'`ownerHealthInsurancePremiums`'} | Owner's personal health insurance premiums |

## Classification Rules

1. **Skip transfers and owner draws** — internal transfers between accounts, owner withdrawals, and personal payments are NOT business expenses. Don't categorize them.
2. **Sales tax remittances** to the Texas Comptroller are NOT a business expense (they're collected from customers and passed through). Don't include.
3. **Sales tax collected from customers** (deposits) — track separately if visible, but don't categorize as expense.
4. **Credit card payments TO the credit card** (paying off the card balance) are NOT a separate expense — the underlying purchases are. Skip these.
5. **Foot Solutions Royalty** payments → ${'`royaltyFees`'}. **Foot Solutions Ad Fund** → ${'`adFundContributions`'}.
6. **Heartland / Global Payments processing fees** → ${'`bankFees`'}.
7. **Property tax / DBA fees / state filings** → ${'`professionalFees`'}.
8. **Large supplier wire transfers (Fedwire, ACH to wholesalers)** for a retail business are most likely inventory purchases → for flagged items, use ${'`cogs`'} as the bestGuessField.
9. **Anything truly ambiguous** → leave it out of categoryTotals and add it to flaggedTransactions with:
   - a one-line reason
   - a \`bestGuessField\` containing the SINGLE most-likely tax-form field name from the table above (or \`cogs\`, \`totalRevenue\`, \`salesTaxCollected\`, \`salesTaxRemitted\` — these are valid fields too). Use \`null\` only if you genuinely have no guess.
   - a \`guessConfidence\` value of "high", "medium", or "low".

${
  isLOC
    ? `## Line of Credit Specifics

For each line of credit payment, the statement should show interest and principal separately. If only the total payment is shown, list it in flaggedTransactions so the user can split manually.

Origination fees, draw fees, annual fees on the LOC → ${'`bankFees`'}.`
    : ''
}

## Output Format
Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "statementType": "${isLOC ? 'line-of-credit' : 'business-checking'}",
  "bankName": "<name of bank, or null>",
  "accountLast4": "<last 4 digits of account, or null>",
  "periodStart": "<YYYY-MM-DD or null>",
  "periodEnd": "<YYYY-MM-DD or null>",
  "categoryTotals": {
    "rentLeasePayments": <sum or 0>,
    "utilities": <sum or 0>,
    "businessInsurancePremiums": <sum or 0>,
    "professionalFees": <sum or 0>,
    "marketingAdvertising": <sum or 0>,
    "officeSupplies": <sum or 0>,
    "softwareSubscriptions": <sum or 0>,
    "bankFees": <sum or 0>,
    "royaltyFees": <sum or 0>,
    "adFundContributions": <sum or 0>,
    "loanInterestPaid": <sum or 0>,
    "loanPrincipalPaid": <sum or 0>,
    "totalEmployeeWages": <sum or 0>,
    "employerHealthInsurance": <sum or 0>,
    "total1099Payments": <sum or 0>,
    "totalEquipmentCost": <sum or 0>,
    "ownerHealthInsurancePremiums": <sum or 0>
  },
  "flaggedTransactions": [
    {"date": "YYYY-MM-DD", "description": "<merchant>", "amount": <number>, "reason": "<short reason>", "bestGuessField": "<one of the keys above, or null>", "guessConfidence": "high|medium|low"}
  ],
  "totalDeposits": <sum of all inflows or 0>,
  "totalWithdrawals": <sum of all outflows or 0>,
  "confidence": "high|medium|low",
  "notes": "<short caveat>"
}

All amounts MUST be plain positive numbers (no $, no commas, no cents — round to nearest dollar). Categories with $0 should be 0, not null. Set fields you cannot determine to null where allowed.

Respond with ONLY the JSON object.${csvBlock}`;
}

// ── Documents — list / download / delete ────────────────────────────

async function handleListDocuments(userId: string): Promise<APIGatewayProxyResultV2> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':uid': userId, ':prefix': 'DOC#' },
        ScanIndexForward: false, // newest first
        Limit: 200,
      })
    );

    const documents = (result.Items ?? []).map((item) => ({
      docId: item['docId'],
      fileName: item['fileName'],
      docType: item['docType'],
      objectKey: item['objectKey'],
      contentType: item['contentType'],
      uploadedAt: item['uploadedAt'],
      appliedTotals: item['appliedTotals'] ?? {},
      flagged: item['flagged'] ?? [],
      bankName: item['bankName'] ?? null,
      periodStart: item['periodStart'] ?? null,
      periodEnd: item['periodEnd'] ?? null,
      confidence: item['confidence'] ?? null,
      notes: item['notes'] ?? null,
      autoClassified: item['autoClassified'] ?? false,
      autoClassifyResult: item['autoClassifyResult'] ?? null,
    }));

    return json(200, { documents });
  } catch (err) {
    console.error('Failed to list documents:', (err as Error).message);
    return json(500, { error: 'Failed to list documents' });
  }
}

async function handleDownloadUrl(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string
): Promise<APIGatewayProxyResultV2> {
  const docId = event.pathParameters?.['id'];
  if (!docId) return json(400, { error: 'Document id is required' });

  // Look up the doc to get the objectKey (and confirm ownership).
  // No Limit — FilterExpression is applied AFTER limit, so a Limit:1
  // would silently return 0 results when the matching item isn't first.
  let item: Record<string, unknown> | undefined;
  try {
    // We need to query by docId since SK includes a timestamp prefix.
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        FilterExpression: 'docId = :docId',
        ExpressionAttributeValues: {
          ':uid': userId,
          ':prefix': 'DOC#',
          ':docId': docId,
        },
      })
    );
    item = result.Items?.[0];
  } catch (err) {
    console.error('Failed to look up document:', (err as Error).message);
    return json(500, { error: 'Failed to look up document' });
  }

  if (!item) return json(404, { error: 'Document not found' });

  const objectKey = item['objectKey'] as string;
  if (!objectKey.startsWith(`${userId}/`)) {
    return json(403, { error: 'Access denied' });
  }

  try {
    const cmd = new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: objectKey });
    const downloadUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 300 });
    return json(200, {
      downloadUrl,
      fileName: item['fileName'],
      expiresIn: 300,
    });
  } catch (err) {
    console.error('Failed to create download URL:', (err as Error).message);
    return json(500, { error: 'Failed to create download URL' });
  }
}

async function handleDeleteDocument(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string
): Promise<APIGatewayProxyResultV2> {
  const docId = event.pathParameters?.['id'];
  if (!docId) return json(400, { error: 'Document id is required' });

  // Find the record (we need its sk to delete + objectKey to remove from S3)
  // No Limit — FilterExpression is applied AFTER limit, so a Limit:1 here
  // would silently return 0 results when the matching item isn't first.
  let item: Record<string, unknown> | undefined;
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        FilterExpression: 'docId = :docId',
        ExpressionAttributeValues: {
          ':uid': userId,
          ':prefix': 'DOC#',
          ':docId': docId,
        },
      })
    );
    item = result.Items?.[0];
  } catch (err) {
    console.error('Failed to look up document for delete:', (err as Error).message);
    return json(500, { error: 'Failed to delete document' });
  }

  if (!item) return json(404, { error: 'Document not found' });

  const sk = item['sk'] as string;
  const objectKey = item['objectKey'] as string;

  // Belt-and-suspenders: confirm ownership via S3 prefix
  if (!objectKey.startsWith(`${userId}/`)) {
    return json(403, { error: 'Access denied' });
  }

  // Delete S3 object first; if it fails, don't orphan the metadata
  try {
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: DOCS_BUCKET, Key: objectKey })
    );
  } catch (err) {
    console.error('Failed to delete S3 object:', (err as Error).message);
    // Continue — S3 errors shouldn't strand the user. They can re-delete from console.
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { userId, sk },
      })
    );
  } catch (err) {
    console.error('Failed to delete metadata record:', (err as Error).message);
    return json(500, { error: 'Failed to delete document metadata' });
  }

  return json(200, {
    docId,
    appliedTotals: item['appliedTotals'] ?? {},
    deleted: true,
  });
}

// ── DELETE /documents — bulk delete all documents for the user ───────
//
// Used by the "Reset Everything" flow. Deletes every doc record AND every S3
// object. Best-effort on S3 errors (so a missing/already-deleted object
// doesn't block the metadata cleanup).
async function handleDeleteAllDocuments(
  userId: string
): Promise<APIGatewayProxyResultV2> {
  let items: Array<Record<string, unknown>> = [];
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':uid': userId, ':prefix': 'DOC#' },
      })
    );
    items = result.Items ?? [];
  } catch (err) {
    console.error(
      'Failed to list documents for bulk delete:',
      (err as Error).message
    );
    return json(500, { error: 'Failed to list documents' });
  }

  if (items.length === 0) {
    return json(200, { deletedCount: 0 });
  }

  // Delete S3 objects in parallel (best-effort — log failures but continue)
  const s3Results = await Promise.allSettled(
    items.map((item) => {
      const objectKey = item['objectKey'] as string;
      if (!objectKey || !objectKey.startsWith(`${userId}/`)) {
        return Promise.reject(new Error('Invalid object key'));
      }
      return s3Client.send(
        new DeleteObjectCommand({ Bucket: DOCS_BUCKET, Key: objectKey })
      );
    })
  );

  const s3FailureCount = s3Results.filter((r) => r.status === 'rejected').length;
  if (s3FailureCount > 0) {
    console.warn(
      `Bulk delete: ${s3FailureCount}/${items.length} S3 deletes failed (continuing with metadata cleanup)`
    );
  }

  // Delete DynamoDB records in parallel
  const ddbResults = await Promise.allSettled(
    items.map((item) =>
      docClient.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { userId, sk: item['sk'] as string },
        })
      )
    )
  );

  const ddbFailureCount = ddbResults.filter(
    (r) => r.status === 'rejected'
  ).length;
  if (ddbFailureCount > 0) {
    console.error(
      `Bulk delete: ${ddbFailureCount}/${items.length} DynamoDB deletes failed`
    );
    return json(500, {
      error: `Deleted ${items.length - ddbFailureCount} of ${items.length} documents. Some metadata could not be removed — try again.`,
    });
  }

  return json(200, {
    deletedCount: items.length,
    s3FailureCount,
  });
}

// ── POST /documents/{id}/flagged/{index}/resolve ─────────────────────
//
// Resolve a flagged transaction. Two actions:
//   action: 'apply' — add the amount to a tax form field, mark resolution
//   action: 'ignore' — mark resolution without applying anywhere
//
// To undo a previous resolution, send action: 'unresolve'. This removes the
// resolution and (if it was 'apply') subtracts the amount back out of
// appliedTotals.
//
// Whitelist of fields to prevent the client from writing arbitrary keys into
// the appliedTotals map. Mirrors CategoryTotals in lambda/shared/types.ts.
const APPLIABLE_FIELDS = new Set<string>([
  'rentLeasePayments',
  'utilities',
  'businessInsurancePremiums',
  'professionalFees',
  'marketingAdvertising',
  'officeSupplies',
  'bankFees',
  'softwareSubscriptions',
  'royaltyFees',
  'adFundContributions',
  'loanInterestPaid',
  'loanPrincipalPaid',
  'totalEmployeeWages',
  'employerHealthInsurance',
  'total1099Payments',
  'totalEquipmentCost',
  'ownerHealthInsurancePremiums',
  'cogs',
  'totalRevenue',
  'salesTaxCollected',
  'salesTaxRemitted',
]);

async function handleResolveFlagged(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userId: string
): Promise<APIGatewayProxyResultV2> {
  const docId = event.pathParameters?.['id'];
  const indexStr = event.pathParameters?.['index'];
  if (!docId) return json(400, { error: 'Document id is required' });
  if (!indexStr) return json(400, { error: 'Flagged index is required' });
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0) {
    return json(400, { error: 'Flagged index must be a non-negative integer' });
  }

  if (!event.body) return json(400, { error: 'Request body is required' });
  let body: { action?: string; field?: string; appliedAmount?: number };
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON in request body' });
  }
  const action = body.action;
  if (action !== 'apply' && action !== 'ignore' && action !== 'unresolve') {
    return json(400, { error: "action must be 'apply', 'ignore', or 'unresolve'" });
  }

  // Look up the doc record
  let item: Record<string, unknown> | undefined;
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid AND begins_with(sk, :prefix)',
        FilterExpression: 'docId = :docId',
        ExpressionAttributeValues: {
          ':uid': userId,
          ':prefix': 'DOC#',
          ':docId': docId,
        },
      })
    );
    item = result.Items?.[0];
  } catch (err) {
    console.error(
      'Failed to look up document for resolve:',
      (err as Error).message
    );
    return json(500, { error: 'Failed to read document' });
  }

  if (!item) return json(404, { error: 'Document not found' });

  const sk = item['sk'] as string;
  const flagged = (item['flagged'] as Array<Record<string, unknown>>) ?? [];
  if (index >= flagged.length) {
    return json(404, { error: 'Flagged transaction index out of range' });
  }

  const flaggedItem = flagged[index]!;
  const txnAmount = Math.abs(Number(flaggedItem['amount'] ?? 0));
  const existingResolution = flaggedItem['resolution'] as
    | { action: string; field?: string; appliedAmount?: number }
    | undefined;

  const appliedTotals =
    (item['appliedTotals'] as Record<string, number>) ?? {};
  const newAppliedTotals: Record<string, number> = { ...appliedTotals };
  let newResolution: Record<string, unknown> | null = null;

  if (action === 'unresolve') {
    if (!existingResolution) {
      return json(400, { error: 'Item is not currently resolved' });
    }
    // If we'd previously applied, back the amount out
    if (
      existingResolution.action === 'apply' &&
      existingResolution.field &&
      typeof existingResolution.appliedAmount === 'number'
    ) {
      const prev = newAppliedTotals[existingResolution.field] ?? 0;
      const next = Math.max(0, prev - existingResolution.appliedAmount);
      if (next === 0) {
        delete newAppliedTotals[existingResolution.field];
      } else {
        newAppliedTotals[existingResolution.field] = next;
      }
    }
    newResolution = null;
  } else if (action === 'apply') {
    if (!body.field || !APPLIABLE_FIELDS.has(body.field)) {
      return json(400, {
        error:
          "field is required and must be one of the supported tax-form fields",
      });
    }
    const amount =
      typeof body.appliedAmount === 'number' && body.appliedAmount > 0
        ? body.appliedAmount
        : txnAmount;
    if (amount <= 0) {
      return json(400, { error: 'amount must be positive' });
    }

    // If already resolved as 'apply', back out the previous before re-applying
    if (
      existingResolution?.action === 'apply' &&
      existingResolution.field &&
      typeof existingResolution.appliedAmount === 'number'
    ) {
      const prev = newAppliedTotals[existingResolution.field] ?? 0;
      newAppliedTotals[existingResolution.field] = Math.max(
        0,
        prev - existingResolution.appliedAmount
      );
    }

    newAppliedTotals[body.field] = (newAppliedTotals[body.field] ?? 0) + amount;
    newResolution = {
      action: 'apply',
      field: body.field,
      appliedAmount: amount,
      resolvedAt: new Date().toISOString(),
    };
  } else {
    // action === 'ignore'
    // Back out a previous apply if there was one
    if (
      existingResolution?.action === 'apply' &&
      existingResolution.field &&
      typeof existingResolution.appliedAmount === 'number'
    ) {
      const prev = newAppliedTotals[existingResolution.field] ?? 0;
      const next = Math.max(0, prev - existingResolution.appliedAmount);
      if (next === 0) {
        delete newAppliedTotals[existingResolution.field];
      } else {
        newAppliedTotals[existingResolution.field] = next;
      }
    }
    newResolution = {
      action: 'ignore',
      resolvedAt: new Date().toISOString(),
    };
  }

  // Build updated flagged array
  const newFlagged = flagged.slice();
  newFlagged[index] = newResolution
    ? { ...flaggedItem, resolution: newResolution }
    : (() => {
        const copy = { ...flaggedItem };
        delete copy['resolution'];
        return copy;
      })();

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId, sk },
        UpdateExpression: 'SET flagged = :f, appliedTotals = :a',
        ExpressionAttributeValues: {
          ':f': newFlagged,
          ':a': newAppliedTotals,
        },
      })
    );
  } catch (err) {
    console.error(
      'Failed to update flagged resolution:',
      (err as Error).message
    );
    return json(500, { error: 'Failed to save resolution' });
  }

  // Compute the delta vs. previous state so the frontend can update form
  // totals without refetching.
  const formDelta: Record<string, number> = {};
  for (const k of new Set([
    ...Object.keys(appliedTotals),
    ...Object.keys(newAppliedTotals),
  ])) {
    const before = appliedTotals[k] ?? 0;
    const after = newAppliedTotals[k] ?? 0;
    if (before !== after) {
      formDelta[k] = after - before;
    }
  }

  return json(200, {
    docId,
    index,
    resolution: newResolution,
    appliedTotals: newAppliedTotals,
    formDelta,
  });
}

// ── Main Handler ─────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string;

  switch (event.routeKey) {
    case 'POST /documents/upload-url':
      return handleUploadUrl(event, userId);
    case 'POST /documents/extract':
      return handleExtract(event, userId);
    case 'POST /documents/bda-job':
      return json(501, { error: 'Not implemented in Phase 1 — use /documents/extract for CSV' });
    case 'GET /documents':
      return handleListDocuments(userId);
    case 'GET /documents/{id}/download-url':
      return handleDownloadUrl(event, userId);
    case 'DELETE /documents/{id}':
      return handleDeleteDocument(event, userId);
    case 'DELETE /documents':
      return handleDeleteAllDocuments(userId);
    case 'POST /documents/{id}/flagged/{index}/resolve':
      return handleResolveFlagged(event, userId);
    default:
      return json(404, { error: 'Route not found' });
  }
};
