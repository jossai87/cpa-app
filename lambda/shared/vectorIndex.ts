/**
 * S3 Vectors helper — embed text via Cohere v3 multilingual and query the
 * Gmail vector index. Shared between gmail-embed (write side) and
 * gmail-analysis (read side).
 *
 * Env required:
 *   VECTOR_BUCKET_NAME — S3 vector bucket name
 *   VECTOR_INDEX_NAME  — vector index name (default 'gmail-messages')
 *   EMBED_MODEL_ID     — Cohere model id (default 'cohere.embed-multilingual-v3')
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  S3VectorsClient,
  PutVectorsCommand,
  QueryVectorsCommand,
} from '@aws-sdk/client-s3vectors';

const REGION = 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3vectors = new S3VectorsClient({ region: REGION });

const VECTOR_BUCKET_NAME = process.env['VECTOR_BUCKET_NAME'] ?? '';
const VECTOR_INDEX_NAME = process.env['VECTOR_INDEX_NAME'] ?? 'gmail-messages';
const EMBED_MODEL_ID = process.env['EMBED_MODEL_ID'] ?? 'cohere.embed-multilingual-v3';

// Cohere v3 caps each input at ~2048 chars. Leave headroom for the
// "Subject: …\nFrom: …\n\n" prefix.
const MAX_EMBED_CHARS = 1900;

/** Truncate a string to N chars (UTF-16 code units; close enough for our text). */
function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n);
}

/**
 * Build the text we feed to the embedder for a Gmail message. Includes
 * subject + from for retrieval recall, then the body.
 */
export function buildEmbedText(args: {
  subject?: string | null;
  from?: string | null;
  bodyText?: string | null;
}): string {
  const subject = (args.subject ?? '').trim();
  const from = (args.from ?? '').trim();
  const body = (args.bodyText ?? '').trim();
  const head = `Subject: ${subject}\nFrom: ${from}\n\n`;
  const allowance = MAX_EMBED_CHARS - head.length;
  return head + truncate(body, Math.max(allowance, 0));
}

/** Call Cohere via Bedrock InvokeModel. Returns a 1024-dim float array. */
export async function embedText(
  text: string,
  inputType: 'search_document' | 'search_query'
): Promise<number[]> {
  const resp = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(
        JSON.stringify({
          texts: [truncate(text, MAX_EMBED_CHARS) || ' '],
          input_type: inputType,
          truncate: 'END',
        })
      ),
    })
  );
  const payload = JSON.parse(new TextDecoder().decode(resp.body)) as {
    embeddings: number[][];
  };
  if (!payload.embeddings?.[0]) {
    throw new Error('Cohere returned no embedding');
  }
  return payload.embeddings[0];
}

export interface VectorMetadata {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  dateOnly: string;
  vendorBrand: string | null;
  kind: string | null;
  // Non-filterable metadata — preserved alongside the vector but not
  // queryable. Used to give the LLM a snippet without a follow-up cache_read.
  bodyPreview: string;
}

/**
 * Insert one vector for a Gmail message into the index. Filterable metadata
 * is anything S3 Vectors lets us filter on later (vendorBrand, kind,
 * dateOnly, etc.). bodyPreview is declared non-filterable at index creation.
 */
export async function putMessageVector(args: {
  messageId: string;
  embedding: number[];
  metadata: VectorMetadata;
}): Promise<void> {
  if (!VECTOR_BUCKET_NAME) throw new Error('VECTOR_BUCKET_NAME env not set');
  // S3 Vectors metadata values must be strings/numbers/booleans. Strip nulls.
  const md: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args.metadata)) {
    if (v === null || v === undefined) continue;
    md[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  await s3vectors.send(
    new PutVectorsCommand({
      vectorBucketName: VECTOR_BUCKET_NAME,
      indexName: VECTOR_INDEX_NAME,
      vectors: [
        {
          key: args.messageId,
          data: { float32: args.embedding },
          metadata: md,
        },
      ],
    })
  );
}

export interface VectorHit {
  messageId: string;
  distance: number | null;
  threadId: string | null;
  from: string | null;
  subject: string | null;
  dateOnly: string | null;
  vendorBrand: string | null;
  kind: string | null;
  bodyPreview: string | null;
}

/** Embed a query string and run a similarity search against the index. */
export async function kbSemanticSearch(
  query: string,
  topK: number,
  filter?: Record<string, unknown>
): Promise<VectorHit[]> {
  if (!VECTOR_BUCKET_NAME) throw new Error('VECTOR_BUCKET_NAME env not set');
  const trimmed = (query ?? '').trim();
  if (!trimmed) return [];
  const k = Math.min(Math.max(Math.floor(topK || 8), 1), 25);
  const embedding = await embedText(trimmed, 'search_query');

  const resp = await s3vectors.send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET_NAME,
      indexName: VECTOR_INDEX_NAME,
      queryVector: { float32: embedding },
      topK: k,
      returnDistance: true,
      returnMetadata: true,
      ...(filter ? { filter: filter as never } : {}),
    })
  );

  const hits = resp.vectors ?? [];
  return hits.map((v) => {
    const md = (v.metadata ?? {}) as Record<string, unknown>;
    return {
      messageId: String(v.key ?? md['messageId'] ?? ''),
      distance: typeof v.distance === 'number' ? v.distance : null,
      threadId: md['threadId'] != null ? String(md['threadId']) : null,
      from: md['from'] != null ? String(md['from']) : null,
      subject: md['subject'] != null ? String(md['subject']) : null,
      dateOnly: md['dateOnly'] != null ? String(md['dateOnly']) : null,
      vendorBrand:
        md['vendorBrand'] != null && String(md['vendorBrand']) !== ''
          ? String(md['vendorBrand'])
          : null,
      kind: md['kind'] != null && String(md['kind']) !== '' ? String(md['kind']) : null,
      bodyPreview: md['bodyPreview'] != null ? String(md['bodyPreview']) : null,
    };
  });
}
