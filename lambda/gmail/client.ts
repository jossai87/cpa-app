/**
 * Gmail API helper for the daily-report Lambda.
 *
 * Uses the refresh token stored in Secrets Manager to mint short-lived
 * access tokens, then queries the Gmail REST API directly. No googleapis
 * SDK dependency — keeps the Lambda bundle small.
 *
 * Multi-account support: use `createGmailClient(tokenSecretName)` to get
 * a client scoped to a specific account. The default exported functions
 * use the primary account (foot-solutions/gmail/refresh-token).
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = 'us-east-1';
const CLIENT_SECRET_NAME = 'foot-solutions/gmail/oauth-client';
const PRIMARY_TOKEN_SECRET = 'foot-solutions/gmail/refresh-token';
const NANCY_TOKEN_SECRET = 'foot-solutions/gmail/refresh-token-nancy';

const sm = new SecretsManagerClient({ region: REGION });

async function loadSecret<T>(name: string): Promise<T> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`);
  return JSON.parse(res.SecretString) as T;
}

// ── Per-account client factory ────────────────────────────────────────

export interface GmailClientInstance {
  searchEmails(query: string, max?: number): Promise<Array<{ id: string; threadId: string }>>;
  getMessage(id: string, maxBodyChars?: number): Promise<{
    id: string; threadId: string; date: string; from: string; to: string;
    subject: string; snippet: string; body: string; truncated: boolean;
    attachments: GmailAttachment[];
  }>;
  getThread(threadId: string, maxBodyChars?: number): Promise<{
    threadId: string;
    messages: Array<{
      id: string; threadId: string; date: string; from: string; to: string;
      subject: string; snippet: string; body: string; truncated: boolean;
    }>;
  }>;
  /** Which account this client is for. */
  accountEmail: string;
}

export function createGmailClient(tokenSecretName: string): GmailClientInstance {
  // Per-instance token cache so multiple accounts don't share a token.
  let cachedToken: { token: string; expiresAt: number } | null = null;
  let resolvedEmail = '';

  async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.token;
    }
    const [client, tokens] = await Promise.all([
      loadSecret<{ client_id: string; client_secret: string }>(CLIENT_SECRET_NAME),
      loadSecret<{ refresh_token: string; email?: string }>(tokenSecretName),
    ]);
    if (tokens.email) resolvedEmail = tokens.email;
    const params = new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`Failed to refresh access token for ${tokenSecretName}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { access_token: string; expires_in: number };
    cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async function gmailFetch<T>(path: string): Promise<T> {
    const token = await getAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return await res.json() as T;
  }

  return {
    get accountEmail() { return resolvedEmail || tokenSecretName; },

    async searchEmails(query: string, max = 20) {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) });
      const res = await gmailFetch<GmailListResponse>(`/messages?${params.toString()}`);
      return res.messages ?? [];
    },

    async getMessage(id: string, maxBodyChars = 4000) {
      const msg = await gmailFetch<GmailMessage>(`/messages/${id}?format=full`);
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
      const fullBody = extractPlainText(msg.payload);
      const body = fullBody.length > maxBodyChars ? fullBody.slice(0, maxBodyChars) : fullBody;
      const attachments = extractAttachments(msg.payload);
      return {
        id: msg.id, threadId: msg.threadId,
        date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
        from: getHeader('From'), to: getHeader('To'), subject: getHeader('Subject'),
        snippet: msg.snippet, body, truncated: fullBody.length > maxBodyChars, attachments,
      };
    },

    async getThread(threadId: string, maxBodyChars = 4000) {
      interface GmailThread { id: string; messages?: GmailMessage[] }
      const t = await gmailFetch<GmailThread>(`/threads/${threadId}?format=full`);
      const out = (t.messages ?? []).map((msg) => {
        const headers = msg.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        const fullBody = extractPlainText(msg.payload);
        const body = fullBody.length > maxBodyChars ? fullBody.slice(0, maxBodyChars) : fullBody;
        return {
          id: msg.id, threadId: msg.threadId,
          date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
          from: getHeader('From'), to: getHeader('To'), subject: getHeader('Subject'),
          snippet: msg.snippet, body, truncated: fullBody.length > maxBodyChars,
        };
      });
      out.sort((a, b) => a.date.localeCompare(b.date));
      return { threadId: t.id, messages: out };
    },
  };
}

// ── Module-level clients (one per account) ────────────────────────────
// These are module-scope so they survive warm Lambda invocations and
// share the per-instance token cache across calls.

const primaryClient = createGmailClient(PRIMARY_TOKEN_SECRET);
const nancyClient   = createGmailClient(NANCY_TOKEN_SECRET);

/** All configured Gmail accounts. Used by gmail-sync to sync both inboxes. */
export const ALL_GMAIL_ACCOUNTS: Array<{ client: GmailClientInstance; accountKey: string }> = [
  { client: primaryClient, accountKey: 'flowermound' },
  { client: nancyClient,   accountKey: 'nancy' },
];

// ── Legacy module-level token cache (primary account) ─────────────────
// Kept for backward compat with existing callers that import the
// top-level functions directly.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  const [client, tokens] = await Promise.all([
    loadSecret<{ client_id: string; client_secret: string }>(CLIENT_SECRET_NAME),
    loadSecret<{ refresh_token: string }>(PRIMARY_TOKEN_SECRET),
  ]);
  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh access token: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function gmailFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as T;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<GmailMessagePart>;
    body?: { data?: string; size?: number };
    mimeType?: string;
  };
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  parts?: Array<GmailMessagePart>;
  body?: { data?: string; size?: number; attachmentId?: string };
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/**
 * Walk the MIME tree and collect all attachment parts.
 * An attachment is any part that has a filename AND an attachmentId
 * (large attachments) or a non-empty body.data (small inline attachments).
 */
export function extractAttachments(payload: GmailMessage['payload']): GmailAttachment[] {
  if (!payload) return [];
  const results: GmailAttachment[] = [];

  function walk(parts: GmailMessagePart[]) {
    for (const part of parts) {
      // Recurse into multipart containers
      if (part.parts) walk(part.parts);
      // Skip text and HTML body parts — we only want attachments
      if (!part.filename || part.filename.trim() === '') continue;
      if (!part.mimeType) continue;
      const attachmentId = part.body?.attachmentId;
      const size = part.body?.size ?? 0;
      // Must have either an attachmentId (large) or inline data (small)
      if (!attachmentId && !part.body?.data) continue;
      results.push({
        filename: part.filename.trim(),
        mimeType: part.mimeType,
        size,
        attachmentId: attachmentId ?? `inline:${part.filename}`,
      });
    }
  }

  if (payload.parts) walk(payload.parts);
  return results;
}

/**
 * Fetch a single attachment's base64-encoded data from the Gmail API.
 * Returns the raw base64url string — caller decodes as needed.
 */
export async function getAttachment(
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  const res = await gmailFetch<{ data: string; size: number }>(
    `/messages/${messageId}/attachments/${attachmentId}`
  );
  return res;
}

/**
 * Search Gmail using their query syntax (e.g. "from:brooks newer_than:14d").
 * https://support.google.com/mail/answer/7190
 *
 * @param query — Gmail search query
 * @param max — maximum messages to return (default 20)
 */
export async function searchEmails(query: string, max = 20): Promise<Array<{ id: string; threadId: string }>> {
  const params = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) });
  const res = await gmailFetch<GmailListResponse>(`/messages?${params.toString()}`);
  return res.messages ?? [];
}

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

function extractPlainText(payload: GmailMessage['payload']): string {
  if (!payload) return '';
  // Recursive walk — prefer text/plain, fall back to text/html (stripped)
  function walk(parts: GmailMessagePart[]): string | null {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of parts) {
      if (part.parts) {
        const found = walk(part.parts);
        if (found) return found;
      }
    }
    // Fall back to html
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    return null;
  }
  if (payload.parts) {
    const text = walk(payload.parts);
    if (text) return text;
  }
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/html') {
      return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return decoded;
  }
  return '';
}

/**
 * Get one message with full headers + plaintext body, truncated to a reasonable size.
 *
 * @param id — message id from searchEmails()
 * @param maxBodyChars — truncate body (default 4000 to keep prompts small)
 */
export async function getMessage(id: string, maxBodyChars = 4000): Promise<{
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  truncated: boolean;
  attachments: GmailAttachment[];
}> {
  const msg = await gmailFetch<GmailMessage>(`/messages/${id}?format=full`);
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const fullBody = extractPlainText(msg.payload);
  const body = fullBody.length > maxBodyChars ? fullBody.slice(0, maxBodyChars) : fullBody;
  const attachments = extractAttachments(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    snippet: msg.snippet,
    body,
    truncated: fullBody.length > maxBodyChars,
    attachments,
  };
}

/**
 * Fetch an entire Gmail thread including every message + bodies.
 * Used by verifyFollowUp to read the live, up-to-the-second state of
 * a thread — bypasses the local cache so newly-arrived replies are
 * picked up immediately.
 *
 * Returns messages oldest-first.
 */
export async function getThread(
  threadId: string,
  maxBodyChars = 4000
): Promise<{
  threadId: string;
  messages: Array<{
    id: string;
    threadId: string;
    date: string;
    from: string;
    to: string;
    subject: string;
    snippet: string;
    body: string;
    truncated: boolean;
  }>;
}> {
  interface GmailThread {
    id: string;
    messages?: GmailMessage[];
  }
  const t = await gmailFetch<GmailThread>(`/threads/${threadId}?format=full`);
  const out = (t.messages ?? []).map((msg) => {
    const headers = msg.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const fullBody = extractPlainText(msg.payload);
    const body = fullBody.length > maxBodyChars ? fullBody.slice(0, maxBodyChars) : fullBody;
    return {
      id: msg.id,
      threadId: msg.threadId,
      date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      snippet: msg.snippet,
      body,
      truncated: fullBody.length > maxBodyChars,
    };
  });
  // Gmail returns messages roughly oldest-first; sort to be safe.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { threadId: t.id, messages: out };
}

/**
 * Convenience scan: search recent emails for vendor names + key people,
 * return a compact summary the model can chew on quickly.
 */
export async function summarizeRecentVendorMail(days = 14): Promise<{
  query: string;
  count: number;
  threads: Array<{ from: string; subject: string; date: string; snippet: string; id: string }>;
}> {
  // Vendor brands likely to appear in inbox + acquisition contacts
  const vendorTerms = [
    'brooks', 'dansko', 'aetrex', 'hoka', 'olukai', 'drew', 'finn', 'rockport',
    'saucony', 'vionic', 'mephisto', 'feetures', 'apex', 'naot', 'yaleet',
  ];
  const peopleTerms = ['roland', 'janell'];
  // Build OR query: any vendor brand OR people, within last N days, exclude promos
  const orClause = [...vendorTerms, ...peopleTerms].map((t) => `"${t}"`).join(' OR ');
  const query = `(${orClause}) newer_than:${days}d -category:promotions`;

  const matches = await searchEmails(query, 30);
  if (matches.length === 0) {
    return { query, count: 0, threads: [] };
  }

  // Fetch lightweight details for each (just headers + snippet, not body)
  const threads = await Promise.all(
    matches.slice(0, 15).map(async (m) => {
      const msg = await gmailFetch<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        id: m.id,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
        snippet: msg.snippet,
      };
    })
  );

  return { query, count: matches.length, threads };
}
