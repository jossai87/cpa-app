/**
 * Gmail Embed Lambda — SQS-triggered.
 *
 * For each {messageId, dateOnly} payload:
 *   1. Read the canonical message row from DynamoDB cache.
 *   2. Build a search-document text (subject + from + body).
 *   3. Embed via Cohere v3 multilingual on Bedrock.
 *   4. PutVectors into the S3 Vectors index with metadata.
 *
 * Uses partial-batch failure reporting so transient failures (Bedrock
 * throttle, S3 Vectors hiccup) only retry the failed messages.
 */

import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  buildEmbedText,
  embedText,
  putMessageVector,
} from '../shared/vectorIndex';

const dynamoClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env['TABLE_NAME']!;
const OWNER_USER_ID = process.env['OWNER_USER_ID']!;
const BODY_PREVIEW_CHARS = 800;

interface EmbedJob {
  messageId: string;
  dateOnly: string;
}

interface CachedRow {
  id: string;
  threadId?: string;
  date?: string;
  dateOnly?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  vendorBrand?: string | null;
  kind?: string | null;
}

async function readCanonical(
  messageId: string,
  dateOnly: string
): Promise<CachedRow | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: OWNER_USER_ID, sk: `GMAIL#MSG#${dateOnly}#${messageId}` },
    })
  );
  return (res.Item as unknown as CachedRow) ?? null;
}

async function processOne(job: EmbedJob): Promise<void> {
  const row = await readCanonical(job.messageId, job.dateOnly);
  if (!row) {
    // No cached row — likely deleted by TTL or not yet written. Drop the
    // message so SQS doesn't keep retrying. The DLQ is reserved for real
    // failures (transient Bedrock / S3 Vectors errors).
    console.warn(
      `embed: no canonical row for ${job.messageId} @ ${job.dateOnly} — skipping`
    );
    return;
  }

  const text = buildEmbedText({
    subject: row.subject,
    from: row.from,
    bodyText: row.bodyText,
  });
  const embedding = await embedText(text, 'search_document');

  const preview = (row.bodyText ?? row.snippet ?? '').slice(0, BODY_PREVIEW_CHARS);

  await putMessageVector({
    messageId: row.id,
    embedding,
    metadata: {
      messageId: row.id,
      threadId: row.threadId ?? '',
      from: row.from ?? '',
      subject: row.subject ?? '',
      dateOnly: row.dateOnly ?? job.dateOnly,
      vendorBrand: row.vendorBrand ?? null,
      kind: row.kind ?? null,
      bodyPreview: preview,
    },
  });
}

function parseJob(body: string | undefined): EmbedJob | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Partial<EmbedJob>;
    if (!parsed.messageId || !parsed.dateOnly) return null;
    return { messageId: String(parsed.messageId), dateOnly: String(parsed.dateOnly) };
  } catch {
    return null;
  }
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchItemFailure[] = [];

  // Process records sequentially. Cohere has a low TPS quota on the embed
  // models and we want to avoid burst throttling.
  for (const record of event.Records) {
    const job = parseJob(record.body);
    if (!job) {
      console.warn(`embed: malformed payload, dropping: ${record.body?.slice(0, 200)}`);
      continue;
    }
    try {
      await processOne(job);
    } catch (err) {
      console.error(
        `embed: failed messageId=${job.messageId} dateOnly=${job.dateOnly}: ${(err as Error).message}`
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
