/**
 * Helpers for deep-linking into Gmail messages from the Foot Solutions app.
 *
 * Gmail's URL scheme:
 *   https://mail.google.com/mail/u/0/?authuser=<email>#all/<threadId>
 *
 * IMPORTANT: Gmail's deep-link target is a THREAD id, not the API message
 * id. The two ids look similar (16 hex chars) but differ. Using #all/
 * scope (rather than #inbox/) ensures the link works whether or not the
 * thread is still in the inbox folder.
 *
 * The backend `resolveThreadIds()` helper translates messageIds → threadIds
 * before returning analysis/highlights to the frontend, and stores the
 * resolved values as `sourceThreadIds` / `sourceThreadId` parallel to the
 * original `sourceMessageIds`. The frontend prefers thread ids when they
 * exist and falls back to message ids (best effort) for older cached rows.
 */

const OWNER_EMAIL = 'flowermound@footsolutions.com';

/** Gmail deep link to a thread (the thing that actually works). */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(
    OWNER_EMAIL
  )}#all/${encodeURIComponent(threadId)}`;
}

/**
 * Best-effort link by raw message id. Gmail's URL syntax expects threadIds
 * here, but for legacy / unresolved ids we still try — Gmail may match the
 * thread that contains it.
 *
 * Prefer `gmailThreadUrl()` when you have a threadId.
 */
export function gmailMessageUrl(messageId: string): string {
  return gmailThreadUrl(messageId);
}

/** Gmail search URL — useful for "show all emails from sender X". */
export function gmailSearchUrl(query: string): string {
  return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(
    OWNER_EMAIL
  )}#search/${encodeURIComponent(query)}`;
}
