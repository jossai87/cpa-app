/**
 * Tool: call_inbox_assistant
 *
 * Cross-domain bridge from the Sales chat to the Gmail cache. Instead of
 * invoking the Gmail Analysis Lambda (which would chain two Bedrock calls
 * and exceed API Gateway's 29s timeout), we query the Gmail cache directly
 * and return raw results. The caller's Bedrock model synthesizes the final
 * answer from the cache data.
 *
 * Lifted verbatim from `case 'call_inbox_assistant':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { cacheQuery, cacheVendorActivity } from '../../gmail-analysis/cache';

export interface CallInboxAssistantArgs {
  /** The question to ask the Inbox Assistant, phrased as a standalone query with full context. */
  question?: string;
}

export async function callInboxAssistant(args: CallInboxAssistantArgs): Promise<string> {
  const question = String(args.question ?? '').trim();
  if (!question) return JSON.stringify({ error: 'question is required' });

  const q = question.toLowerCase();

  // Detect vendor mentions — check against known brand names
  const VENDOR_NAMES = [
    'brooks', 'dansko', 'aetrex', 'hoka', 'olukai', 'drew', 'saucony',
    'vionic', 'mephisto', 'apex', 'naot', 'yaleet', 'sanita', 'feetures',
    'rockport', 'instride', 'xelero', 'shu-re-nu', 'fidelio', 'berkemann',
    'justin blair', 'pedag', 'finn', 'waldlaufer', 'giesswein', 'caleres',
  ];
  const mentionedVendor = VENDOR_NAMES.find((v) => q.includes(v));

  // Detect person mentions
  const PEOPLE = ['nancy', 'justin', 'roland', 'janell'];
  const mentionedPerson = PEOPLE.find((p) => q.includes(p));

  // Detect kind hints
  const kind = q.includes('invoice') || q.includes('bill') || q.includes('payment due')
    ? 'invoice'
    : q.includes('customer') || q.includes('appointment') || q.includes('inquiry')
      ? 'customer'
      : mentionedVendor ? 'vendor'
      : undefined;

  // Build a free-text search term from the question
  const textHints = [mentionedVendor, mentionedPerson]
    .filter(Boolean)
    .join(' ') || undefined;

  try {
    // Run up to 2 parallel queries for breadth
    const queries: Promise<unknown>[] = [];

    if (mentionedVendor) {
      // Vendor activity rollup — fast and comprehensive
      queries.push(cacheVendorActivity(mentionedVendor, 180));
    }

    // General cache query
    queries.push(cacheQuery({
      vendor: mentionedVendor,
      kind: kind as 'invoice' | 'vendor' | 'customer' | 'internal' | undefined,
      from: mentionedPerson,
      text: textHints,
      limit: 10,
    }));

    const results = await Promise.all(queries);
    return JSON.stringify({
      question,
      note: 'Raw Gmail cache results — synthesize the answer from this data.',
      results,
    });
  } catch (err) {
    return JSON.stringify({ error: `Gmail cache query failed: ${(err as Error).message}` });
  }
}
