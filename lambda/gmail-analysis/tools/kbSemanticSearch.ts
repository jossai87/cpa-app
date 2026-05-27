/**
 * kb_semantic_search tool callback.
 *
 * Extracted from the runChat tool dispatch in
 * `lambda/gmail-analysis/index.ts` so it can be reused by the
 * AgentCore Strands container (Phase 1) without duplicating logic.
 *
 * Pure refactor: behavior is identical to the original branch.
 * The shared vector index helper is preserved unchanged at
 * `lambda/shared/vectorIndex.ts`.
 */

import { kbSemanticSearch as vectorKbSearch } from '../../shared/vectorIndex';

export interface KbSemanticSearchArgs {
  /** Natural-language search query. */
  query: string;
  /** Number of hits to return. Default 8, hard cap 25. */
  top_k?: number;
}

/**
 * Semantic search over the cached Gmail corpus (Cohere embeddings via
 * Bedrock + S3 Vectors). Returns `{ query, count, hits }` — the shape
 * the original tool branch produced. The tool loop stringifies it
 * before sending to Bedrock.
 */
export async function kbSemanticSearch(args: KbSemanticSearchArgs) {
  const query = String(args.query ?? '');
  const topK = Math.min(Number(args.top_k) || 8, 25);
  const hits = await vectorKbSearch(query, topK);
  return { query, count: hits.length, hits };
}
