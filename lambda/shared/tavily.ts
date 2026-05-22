/**
 * Tavily web search client.
 *
 * Tavily docs: https://docs.tavily.com/docs/rest-api/api-reference
 *
 * The API key lives in Secrets Manager at foot-solutions/tavily/api-key
 * with shape { apiKey: string }. Cached in Lambda warm memory.
 *
 * Two helpers:
 *   - tavilySearch(query, opts) — returns search results array
 *   - tavilySummarize(query)    — returns Tavily's "answer" string
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = 'us-east-1';
const SECRET_ID = 'foot-solutions/tavily/api-key';

const sm = new SecretsManagerClient({ region: REGION });
let cachedKey: string | null = null;

async function loadApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!res.SecretString) throw new Error(`Secret ${SECRET_ID} is empty`);
  const parsed = JSON.parse(res.SecretString) as { apiKey: string };
  if (!parsed.apiKey) throw new Error(`Secret ${SECRET_ID} missing apiKey`);
  cachedKey = parsed.apiKey;
  return cachedKey;
}

export interface TavilySearchOptions {
  /** "basic" (default) is fast and cheap; "advanced" digs deeper. */
  searchDepth?: 'basic' | 'advanced';
  /** Number of results (default 5, max 20). */
  maxResults?: number;
  /** When true, Tavily generates a synthesized answer in addition to results. */
  includeAnswer?: boolean;
  /** Limit to news-only sources. Useful for "recent news about X". */
  topic?: 'general' | 'news';
  /** Restrict to last N days when topic=news. */
  days?: number;
  /** Domains to include. */
  includeDomains?: string[];
  /** Domains to exclude. */
  excludeDomains?: string[];
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface TavilyResponse {
  answer?: string;
  query: string;
  results: TavilySearchResult[];
  responseTime?: number;
}

/**
 * Run a Tavily search. Throws on transport / API errors so callers can catch
 * and degrade gracefully.
 */
export async function tavilySearch(
  query: string,
  opts: TavilySearchOptions = {}
): Promise<TavilyResponse> {
  const apiKey = await loadApiKey();
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    search_depth: opts.searchDepth ?? 'basic',
    max_results: Math.min(opts.maxResults ?? 5, 20),
    include_answer: opts.includeAnswer ?? false,
  };
  if (opts.topic) body['topic'] = opts.topic;
  if (opts.days) body['days'] = opts.days;
  if (opts.includeDomains?.length) body['include_domains'] = opts.includeDomains;
  if (opts.excludeDomains?.length) body['exclude_domains'] = opts.excludeDomains;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TavilyResponse;
}

/** Convenience: just the Tavily-generated answer, with truncation. */
export async function tavilySummarize(query: string, days = 7): Promise<string> {
  const r = await tavilySearch(query, {
    searchDepth: 'basic',
    maxResults: 5,
    includeAnswer: true,
    topic: 'news',
    days,
  });
  return r.answer ?? '(no summary)';
}
