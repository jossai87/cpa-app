/**
 * Frontend-only mirror of the backend `wrapCampaignHtml` in
 * `lambda/heartland/index.ts`. Produces the SAME branded shell
 * (header + body + footer with unsubscribe link) so admins can see
 * exactly how a campaign will render in a recipient's inbox before
 * hitting Send.
 *
 * Keep this in sync if the backend wrapper ever changes.
 */

const CAMPAIGN_STORE_NAME = 'Foot Solutions Flower Mound';
const CAMPAIGN_STORE_ADDRESS = '2321 Justin Rd, Flower Mound, TX 75028';
const CAMPAIGN_REPLY_TO = 'flowermound@footsolutions.com';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Title-case a name so "KATHY" → "Kathy" and "MARY-ANNE" → "Mary-Anne".
 * Mirrors the title-casing in the backend `wrapCampaignHtml` so the
 * preview matches what recipients will see.
 */
function titleCaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep: string, ch: string) =>
      sep + ch.toUpperCase()
    );
}

export interface PreviewOptions {
  bodyHtml: string;
  /** First name shown in the greeting line. Use a placeholder for the preview. */
  recipientName?: string;
}

/**
 * Build the full HTML email document the recipient will see.
 * The unsubscribe link in the preview goes to a fake `#unsubscribe`
 * anchor — the real link is generated server-side at send time.
 */
export function buildCampaignPreviewHtml({
  bodyHtml,
  recipientName,
}: PreviewOptions): string {
  const firstNameRaw = recipientName ? recipientName.trim().split(/\s+/)[0] ?? '' : '';
  const friendlyFirst = firstNameRaw ? titleCaseName(firstNameRaw) : '';
  const greeting = friendlyFirst
    ? `<p style="margin:0 0 16px">Hi ${escapeHtml(friendlyFirst)},</p>`
    : `<p style="margin:0 0 16px">Hi there,</p>`;

  const unsubUrl = '#preview-unsubscribe';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1e293b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc"><tr><td align="center" style="padding:32px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <tr><td style="padding:24px 32px 8px 32px;border-bottom:1px solid #e2e8f0">
      <p style="margin:0;font-size:18px;font-weight:600;color:#1e293b">Foot Solutions Flower Mound</p>
      <p style="margin:4px 0 0;font-size:12px;color:#64748b">${CAMPAIGN_STORE_ADDRESS}</p>
    </td></tr>
    <tr><td style="padding:24px 32px 24px 32px;font-size:15px;line-height:1.55;color:#1e293b">
      ${greeting}
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.5">
      <p style="margin:0">Questions? Reply to this email or contact <a href="mailto:${CAMPAIGN_REPLY_TO}" style="color:#2563eb">${CAMPAIGN_REPLY_TO}</a>.</p>
      <p style="margin:8px 0 0">${CAMPAIGN_STORE_NAME} · ${CAMPAIGN_STORE_ADDRESS}</p>
      <p style="margin:8px 0 0">You're receiving this email because you opted in at our store. <a href="${unsubUrl}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
