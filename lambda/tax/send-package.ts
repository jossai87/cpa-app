/**
 * CPA Package Send — POST /tax/cpa-package/send
 *
 * Builds a zip server-side, uploads to S3, generates a pre-signed URL
 * (the URL itself is the security — unguessable + short-lived), then
 * sends two SES emails:
 *
 *   Email 1 → CPA (recipientEmail)
 *     Clean download link. No password required — the signed URL expires
 *     in ttlHours and is the access control.
 *
 *   Email 2 → Owner (OWNER_NOTIFY_EMAIL = dreamthatbuild@gmail.com)
 *     Send confirmation: who got it, when the link expires, doc count.
 */

import {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { zipSync, strToU8 } from 'fflate';
import { v4 as uuidv4 } from 'uuid';

const REGION = 'us-east-1';
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const ses = new SESv2Client({ region: REGION });

const TABLE_NAME = process.env['TABLE_NAME']!;
const DOCS_BUCKET = process.env['DOCS_BUCKET']!;
const FROM_ADDRESS = process.env['FROM_ADDRESS'] ?? 'notifications@fsmanagementsystem.com';
const OWNER_NOTIFY_EMAIL = process.env['OWNER_NOTIFY_EMAIL'] ?? 'dreamthatbuild@gmail.com';

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function fetchS3Object(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty body for ${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

interface SendPackageBody {
  sessionId: string;
  recipientName: string;
  recipientEmail: string;
  ttlHours?: number;
  notes?: string;
}

export async function handleSendPackage(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'Request body is required' });

  let body: SendPackageBody;
  try { body = JSON.parse(event.body) as SendPackageBody; }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { sessionId, recipientName, recipientEmail } = body;
  const ttlHours = Math.min(Math.max(body.ttlHours ?? 48, 1), 168);
  const notes = body.notes?.trim() ?? '';

  if (!sessionId) return json(400, { error: 'sessionId is required' });
  if (!recipientEmail?.includes('@')) return json(400, { error: 'Valid recipientEmail is required' });

  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string;

  // Load tax session
  const sessionRes = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, sk: `TAX#${sessionId}` } })
  );
  if (!sessionRes.Item) return json(404, { error: 'Tax session not found' });
  const session = sessionRes.Item;
  if (session['status'] !== 'complete') return json(400, { error: 'Tax session is not yet complete' });
  const taxYear = session['taxYear'] as number;

  // Load documents
  const docsRes = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':u': userId, ':p': 'DOC#' },
      ScanIndexForward: false,
      Limit: 200,
    })
  );
  const docs = (docsRes.Items ?? []) as Array<Record<string, unknown>>;

  const now = new Date();
  const stamp = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);
  const expiryStr = expiresAt.toLocaleString('en-US', {
    timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short',
  });

  // ── Build zip ────────────────────────────────────────────────────────
  const files: Record<string, Uint8Array> = {};

  // README
  const readmeLines = [
    `Foot Solutions — CPA Tax Package`,
    `Generated: ${stamp} (Central Time)`,
    `Tax Year: ${taxYear}`,
    `Prepared for: ${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}`,
    ``,
    `Download link expires: ${expiryStr} (Central Time)`,
    ``,
    `Contents`,
    `--------`,
    `tax_summary.csv  — Form inputs`,
    `tax_analysis.csv — AI-assisted estimate`,
    `manifest.csv     — Document index`,
    `documents/       — ${docs.length} source file${docs.length === 1 ? '' : 's'}`,
    ``,
    notes ? `Notes from owner\n----------------\n${notes}\n` : '',
    `IMPORTANT: AI extraction can miss entries. Verify against source documents.`,
    `Disclaimer: AI-assisted estimate using 2026 tax law. Requires CPA review.`,
  ].filter(Boolean).join('\r\n');
  files['README.txt'] = strToU8(readmeLines);

  // tax_summary.csv
  const inputData = session['inputData'] as Record<string, unknown> | undefined;
  if (inputData) {
    const rows = Object.entries(inputData)
      .map(([k, v]) => `"${k}","${String(v ?? '').replace(/"/g, '""')}"`)
      .join('\r\n');
    files['tax_summary.csv'] = strToU8(`\uFEFF"Field","Value"\r\n${rows}`);
  }

  // tax_analysis.csv
  const result = session['bedrockResponse'] as Record<string, unknown> | undefined;
  if (result) {
    const arr = (key: string) =>
      ((result[key] as string[] | undefined) ?? []).map((s) => `"${s.replace(/"/g, '""')}"`).join('\r\n');
    const rows = [
      `\uFEFF"Metric","Value"`,
      `"Federal Taxable Income","${result['estimatedFederalTaxableIncome'] ?? ''}"`,
      `"Federal Tax Liability","${result['estimatedFederalTaxLiability'] ?? ''}"`,
      `"Self-Employment Tax","${result['estimatedSelfEmploymentTax'] ?? ''}"`,
      `"Texas Franchise Tax","${result['estimatedTexasFranchiseTax'] ?? ''}"`,
      `"QBI Deduction","${result['qbiDeduction'] ?? ''}"`,
      `"TX Margin Method","${result['texasMarginMethodUsed'] ?? ''}"`,
      ``, `"Key Deductions"`, arr('keyDeductions'),
      ``, `"Tax-Saving Opportunities"`, arr('taxSavingOpportunities'),
      ``, `"Flagged for CPA Review"`, arr('flaggedForCPAReview'),
      ``, `"Forms to File"`, arr('formsToFile'),
      ``, `"Year-over-Year Changes"`, arr('yearOverYearChanges'),
      ``, `"Owner Summary"`, `"${String(result['ownerSummary'] ?? '').replace(/"/g, '""')}"`,
      ``, `"Disclaimer"`, `"${String(result['disclaimer'] ?? '').replace(/"/g, '""')}"`,
    ].join('\r\n');
    files['tax_analysis.csv'] = strToU8(rows);
  }

  // manifest.csv
  const manifestRows = [
    `\uFEFF"#","Filename","Type","Uploaded","Confidence","Applied Totals"`,
    ...docs.map((d, i) => {
      const totals = Object.entries((d['appliedTotals'] as Record<string, number> | undefined) ?? {})
        .filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join('; ');
      return `"${i + 1}","${d['fileName']}","${d['docType']}","${d['uploadedAt']}","${d['confidence'] ?? ''}","${totals}"`;
    }),
  ].join('\r\n');
  files['manifest.csv'] = strToU8(manifestRows);

  // Source documents
  const fetchErrors: string[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!;
    const objectKey = d['objectKey'] as string | undefined;
    if (!objectKey) continue;
    try {
      const bytes = await fetchS3Object(objectKey);
      const idx = String(i + 1).padStart(3, '0');
      const safeName = String(d['fileName'] ?? 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
      files[`documents/${idx}_${safeName}`] = bytes;
    } catch (err) {
      fetchErrors.push(`${d['fileName']}: ${(err as Error).message}`);
    }
  }
  if (fetchErrors.length > 0) files['documents/_errors.txt'] = strToU8(fetchErrors.join('\r\n'));

  const zipBytes = zipSync(files, { level: 6 });

  // ── Upload to S3 ─────────────────────────────────────────────────────
  const packageId = uuidv4();
  const s3Key = `cpa-packages/${now.toISOString().slice(0, 10)}/${packageId}/FootSolutions_CPA_Package_${taxYear}.zip`;
  await s3.send(new PutObjectCommand({
    Bucket: DOCS_BUCKET, Key: s3Key, Body: zipBytes,
    ContentType: 'application/zip', Tagging: 'type=cpa-package',
    Metadata: { 'tax-year': String(taxYear), 'recipient-email': recipientEmail, 'created-by': userId },
  }));

  // ── Pre-signed download URL ───────────────────────────────────────────
  // The signed URL is the access control — unguessable 128-bit random path,
  // expires in ttlHours. No password needed.
  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: DOCS_BUCKET, Key: s3Key,
      ResponseContentDisposition: `attachment; filename="FootSolutions_CPA_Package_${taxYear}.zip"`,
    }),
    { expiresIn: ttlHours * 3600 }
  );

  // ── Email 1 → CPA: clean download link ───────────────────────────────
  const cpaHtml = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px">📦 CPA Tax Package — Foot Solutions (${taxYear})</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 16px">Sent securely from the Foot Solutions Management System</p>
    <p>Hi ${recipientName || 'there'},</p>
    <p>Your client has shared their <strong>Tax Year ${taxYear} CPA package</strong> with you. It contains the tax form snapshot, AI-assisted analysis, and all source documents.</p>
    <div style="margin:24px 0;text-align:center">
      <a href="${downloadUrl}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;display:inline-block">⬇ Download Package (.zip)</a>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px;margin-bottom:16px">
      <p style="margin:0;font-size:13px;color:#14532d">
        🔒 <strong>Secure link.</strong> This link is unique to you and expires on <strong>${expiryStr} (Central Time)</strong>.
        Do not forward this email — the link grants direct access to the package.
      </p>
    </div>
    <p style="font-size:13px;color:#64748b">
      <strong>Includes:</strong> ${docs.length} source document${docs.length === 1 ? '' : 's'} + tax summary + AI analysis
    </p>
    ${notes ? `<div style="border-top:1px solid #e2e8f0;margin-top:16px;padding-top:16px"><p style="font-size:13px;color:#475569"><strong>Note from client:</strong><br>${notes.replace(/\n/g, '<br>')}</p></div>` : ''}
    <p style="font-size:12px;color:#94a3b8;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px">AI-assisted estimate using 2026 tax law. Final liability requires CPA review.</p>
  </div></body></html>`;

  const cpaText = [
    `CPA Tax Package — Foot Solutions (${taxYear})`,
    ``,
    `Hi ${recipientName || 'there'},`,
    ``,
    `Your client has shared their Tax Year ${taxYear} CPA package with you.`,
    ``,
    `Download: ${downloadUrl}`,
    ``,
    `This link is unique to you and expires: ${expiryStr} (Central Time)`,
    `Do not forward this email — the link grants direct access.`,
    ``,
    `Includes: ${docs.length} source document${docs.length === 1 ? '' : 's'} + tax summary + AI analysis`,
    notes ? `\nNote from client:\n${notes}` : '',
    ``,
    `AI-assisted estimate. Final liability requires CPA review.`,
  ].filter(Boolean).join('\n');

  await ses.send(new SendEmailCommand({
    FromEmailAddress: `Foot Solutions <${FROM_ADDRESS}>`,
    Destination: { ToAddresses: [recipientEmail] },
    Content: { Simple: {
      Subject: { Data: `📦 CPA Tax Package — Foot Solutions ${taxYear} (secure download)` },
      Body: { Html: { Data: cpaHtml }, Text: { Data: cpaText } },
    }},
  }));

  // ── Email 2 → Owner: send confirmation ───────────────────────────────
  const ownerHtml = `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b">
  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:24px">
    <h2 style="margin:0 0 8px;color:#14532d">✅ CPA Package Sent — Tax Year ${taxYear}</h2>
    <p style="color:#166534;font-size:15px">
      Your Tax Year ${taxYear} package was successfully sent to <strong>${recipientName}</strong>.
    </p>
    <table style="width:100%;font-size:14px;color:#475569;border-collapse:collapse;margin-top:16px">
      <tr><td style="padding:6px 0;font-weight:600;width:140px">Sent to:</td><td>${recipientName} &lt;${recipientEmail}&gt;</td></tr>
      <tr><td style="padding:6px 0;font-weight:600">Tax year:</td><td>${taxYear}</td></tr>
      <tr><td style="padding:6px 0;font-weight:600">Sent at:</td><td>${stamp} (Central Time)</td></tr>
      <tr><td style="padding:6px 0;font-weight:600">Link expires:</td><td>${expiryStr} (Central Time)</td></tr>
      <tr><td style="padding:6px 0;font-weight:600">Docs included:</td><td>${docs.length} file${docs.length === 1 ? '' : 's'}</td></tr>
    </table>
    <p style="font-size:12px;color:#94a3b8;margin-top:20px;border-top:1px solid #d1fae5;padding-top:12px">
      The download link is secured by a unique, expiring AWS pre-signed URL.
      No password is required — the link itself is the access control.
    </p>
  </div></body></html>`;

  const ownerText = [
    `CPA Package Sent — Tax Year ${taxYear}`,
    ``,
    `Sent to: ${recipientName} <${recipientEmail}>`,
    `Sent at: ${stamp} (Central Time)`,
    `Link expires: ${expiryStr} (Central Time)`,
    `Docs included: ${docs.length}`,
    ``,
    `The link is secured by a unique, expiring pre-signed URL. No password required.`,
  ].join('\n');

  await ses.send(new SendEmailCommand({
    FromEmailAddress: `Foot Solutions <${FROM_ADDRESS}>`,
    Destination: { ToAddresses: [OWNER_NOTIFY_EMAIL] },
    Content: { Simple: {
      Subject: { Data: `✅ CPA Package Sent — Foot Solutions ${taxYear} → ${recipientName}` },
      Body: { Html: { Data: ownerHtml }, Text: { Data: ownerText } },
    }},
  }));

  // ── Record in DynamoDB ────────────────────────────────────────────────
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      userId, sk: `TAX_PKG#${packageId}`, packageId, sessionId, taxYear,
      recipientName, recipientEmail, ttlHours, s3Key,
      sentAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      status: 'sent', docsIncluded: docs.length,
    },
  }));

  return json(200, {
    packageId,
    sentAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    recipientEmail,
    ttlHours,
    docsIncluded: docs.length,
    message: `Package emailed to ${recipientEmail}. Confirmation sent to ${OWNER_NOTIFY_EMAIL}.`,
  });
}
