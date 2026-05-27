/**
 * Shared helpers for the Sales chat tools.
 *
 * Centralised here because they're used by 3+ extracted tool functions
 * in `lambda/chat/tools/` as well as the dispatcher in `lambda/chat/index.ts`.
 *
 * No behavior change — these are lifted verbatim from `lambda/chat/index.ts`.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { VENDOR_CONTACTS } from '../shared/vendorContacts';

export const STORE_TZ = 'America/Chicago';

/** Format a Date as YYYY-MM-DD in the store's local time zone. */
export function ctDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Today's date as YYYY-MM-DD in the store's local time zone. */
export function todayStr(): string {
  return ctDateStr();
}

/** YYYY-MM-DD `n` days before today (UTC math, formatted in store TZ). */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return ctDateStr(d);
}

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Look up a vendor by name, case-insensitively, also checking aliases. */
export function lookupVendor(
  name: string
): { key: string; data: typeof VENDOR_CONTACTS[string] } | null {
  const upper = name.toUpperCase().trim();
  // Direct match
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (key.toUpperCase() === upper) return { key, data };
  }
  // Alias match
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (data.aliases?.some((a) => a.toUpperCase() === upper)) return { key, data };
  }
  // Partial match (contains)
  for (const [key, data] of Object.entries(VENDOR_CONTACTS)) {
    if (key.toUpperCase().includes(upper) || upper.includes(key.toUpperCase())) {
      return { key, data };
    }
  }
  return null;
}

/**
 * Per-cache_read attachment record collected during a tool-use loop turn so
 * the frontend can render `<AttachmentChip />` alongside the assistant reply.
 */
export interface AttachmentRef {
  messageId: string;
  subject?: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
}

/**
 * Context object passed to every extracted tool function.
 *
 * Bundles the dependencies (DynamoDB client, owner id, table name, the
 * authenticated caller's id, the per-turn attachment collector) that each
 * `case` in the original `executeTool` switch relied on as module-level
 * globals.
 */
export interface ToolContext {
  docClient: DynamoDBDocumentClient;
  tableName: string;
  ownerUserId: string;
  /** Cognito sub of the request's caller — used by tools that read per-user data (e.g. tax sessions). */
  callerUserId?: string | undefined;
  /**
   * Optional collector for `cache_read` to push attachment metadata into.
   * The chat handler reads from this list after the tool-use loop completes
   * and surfaces it on the response.
   */
  attachmentCollector?: AttachmentRef[] | undefined;
}
