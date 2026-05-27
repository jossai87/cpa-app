/**
 * Pre-baked campaign email templates for the Foot Solutions Flower Mound
 * Campaign card. The composer wraps the chosen body with the standard
 * branded header (Foot Solutions logo + name) and CAN-SPAM-compliant
 * footer (store address + unsubscribe link), so each template here is
 * just the middle content.
 *
 * Each template includes:
 *   • subject:       email subject line
 *   • bodyHtml:      HTML body (anything between <p>/<h2>/<a>/<img>)
 *   • description:   one-liner shown in the picker
 *   • bestFor:       audience hint (e.g. "12-month dormant", "all opted-in")
 */

export interface CampaignTemplate {
  id: string;
  name: string;
  emoji: string;
  subject: string;
  bodyHtml: string;
  description: string;
  bestFor: string;
}

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  // ── Win-back / dormant customer templates ─────────────────────────
  {
    id: 'we-miss-you',
    name: 'We miss you',
    emoji: '💚',
    subject: 'We miss you at Foot Solutions Flower Mound',
    description: 'Friendly nudge for customers who haven\'t visited in a while.',
    bestFor: '6-month dormant',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">We miss you!</h2>
<p>It's been a while since we've seen you at our Flower Mound store, and we wanted to say hi.</p>
<p>We've got a fresh round of <strong>Hokas, Brooks, Aetrex orthotics, and more</strong> in stock — perfect timing if your current shoes are due for a refresh.</p>
<p style="background:#f0f9ff;border-left:4px solid #2563eb;padding:12px 16px;margin:16px 0;border-radius:0 8px 8px 0">
  <strong>Stop by this week and we'll do a free fit assessment</strong> — no appointment needed.
</p>
<p>Hope to see you soon,<br/>
<strong>Nancy &amp; Justin</strong><br/>
<em style="color:#64748b">Foot Solutions Flower Mound</em></p>`,
  },
  {
    id: 'comeback-discount',
    name: 'Welcome-back discount',
    emoji: '🎁',
    subject: 'A 15% thank-you for coming back to Foot Solutions',
    description: 'Discount offer to bring lapsed customers back through the door.',
    bestFor: '12-month dormant',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">It's been too long.</h2>
<p>We've missed having you in the store — and we'd love a chance to win you back.</p>
<div style="background:#fef3c7;border:2px dashed #f59e0b;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
  <p style="margin:0;font-size:14px;color:#92400e;text-transform:uppercase;letter-spacing:1px;font-weight:600">Welcome back gift</p>
  <p style="margin:8px 0 0;font-size:32px;font-weight:bold;color:#78350f">15% OFF</p>
  <p style="margin:8px 0 0;font-size:13px;color:#92400e">your next pair of shoes or orthotics</p>
  <p style="margin:12px 0 0;font-size:11px;color:#92400e">Just mention this email at checkout. Valid for 30 days.</p>
</div>
<p>Whether you're looking for everyday comfort or solving a specific foot issue, we're here for you.</p>
<p>See you soon,<br/>
<strong>Nancy &amp; Justin Ossai</strong><br/>
<em style="color:#64748b">Foot Solutions Flower Mound</em></p>`,
  },

  // ── Promotional / seasonal ────────────────────────────────────────
  {
    id: 'new-arrivals',
    name: 'New arrivals',
    emoji: '✨',
    subject: 'Just arrived: new shoes worth checking out',
    description: 'Announce new inventory — works year-round.',
    bestFor: 'all reachable',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Fresh arrivals at the store</h2>
<p>The latest from our top brands just hit the floor — and a few of these went fast last season.</p>
<ul style="padding-left:20px;line-height:1.7">
  <li><strong>Hoka Bondi 9</strong> — even softer than the 8</li>
  <li><strong>Brooks Ghost 17</strong> — daily trainer, great for walking and casual runs</li>
  <li><strong>OluKai sandals</strong> — comfort sandal collection for spring/summer</li>
  <li><strong>Aetrex Lynco orthotics</strong> — restocked in all sizes</li>
</ul>
<p>Come by and try them on — fitting is free, walks are free, and our team knows every model inside out.</p>
<p>Cheers,<br/>
<strong>The Foot Solutions Flower Mound team</strong></p>`,
  },
  {
    id: 'orthotics-reminder',
    name: 'Custom orthotics check-in',
    emoji: '🦶',
    subject: 'Time for an orthotics check-up?',
    description: 'Reminder for past orthotics customers — typical replacement is every 12-18 months.',
    bestFor: '12-month dormant',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Time for a check-in on your orthotics?</h2>
<p>Custom orthotics typically need a refresh every <strong>12-18 months</strong> — the cushioning compresses, the molded shape relaxes, and you stop getting the support that made them work in the first place.</p>
<p>If it's been a while, here's what we'd recommend:</p>
<ol style="padding-left:20px;line-height:1.7">
  <li><strong>Bring your current orthotics in</strong> — we'll take a look and tell you honestly whether they have life left</li>
  <li><strong>Walk on our pressure plate</strong> — same one we used the first time, free</li>
  <li><strong>Try the new Lyncos and OTC fittings</strong> if a refresh isn't worth it yet</li>
</ol>
<p>No appointment needed. We're typically slowest before noon if you want a quiet visit.</p>
<p>See you,<br/>
<strong>Nancy &amp; Justin</strong></p>`,
  },
  {
    id: 'birthday-month',
    name: 'Birthday month special',
    emoji: '🎂',
    subject: 'Happy birthday from Foot Solutions Flower Mound',
    description: 'Light-touch birthday email with a small perk.',
    bestFor: 'all reachable',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Happy birthday! 🎂</h2>
<p>From everyone at Foot Solutions Flower Mound — we hope you have a wonderful day.</p>
<div style="background:#fce7f3;border:2px solid #ec4899;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
  <p style="margin:0;font-size:13px;color:#9f1239;text-transform:uppercase;letter-spacing:1px;font-weight:600">Birthday treat</p>
  <p style="margin:8px 0 0;font-size:24px;font-weight:bold;color:#831843">$20 OFF</p>
  <p style="margin:6px 0 0;font-size:13px;color:#9f1239">any purchase of $100 or more this month</p>
  <p style="margin:10px 0 0;font-size:11px;color:#9f1239">Mention this email at checkout</p>
</div>
<p>Treat yourself to a comfortable next year. 🎁</p>
<p>Cheers,<br/>
<strong>Nancy &amp; Justin Ossai</strong></p>`,
  },

  // ── Operational / informational ───────────────────────────────────
  {
    id: 'new-ownership',
    name: 'New ownership announcement',
    emoji: '🤝',
    subject: 'A note from the new owners of Foot Solutions Flower Mound',
    description: 'One-time announcement that Nancy and Justin have taken over.',
    bestFor: 'all reachable, first-time send',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Hi from the new owners 👋</h2>
<p>We're <strong>Nancy and Justin Ossai</strong>, the new owners of Foot Solutions Flower Mound. Roland and Janell handed the reins to us in May 2026, and we wanted to introduce ourselves to the community of customers they built over the years.</p>
<p><strong>What's the same:</strong></p>
<ul style="padding-left:20px;line-height:1.7">
  <li>Same store at <strong>2321 Justin Rd, Flower Mound</strong></li>
  <li>Same staff and same brands you know — Brooks, Hoka, Aetrex, OluKai, Drew, Vionic, and more</li>
  <li>Same focus on actually fitting your feet, not just selling shoes</li>
</ul>
<p><strong>What's new:</strong></p>
<ul style="padding-left:20px;line-height:1.7">
  <li>We're investing in fresh inventory across every brand</li>
  <li>Improving our follow-up so we can actually be helpful between visits</li>
</ul>
<p>If you have a moment, stop by and say hi. We'd love to meet the people who've made this store what it is.</p>
<p>Warmly,<br/>
<strong>Nancy &amp; Justin Ossai</strong><br/>
<em style="color:#64748b">Foot Solutions Flower Mound</em></p>`,
  },
  {
    id: 'holiday-hours',
    name: 'Holiday hours',
    emoji: '🎄',
    subject: 'Foot Solutions Flower Mound — holiday hours',
    description: 'Quick informational email about modified store hours.',
    bestFor: 'all reachable',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Holiday hours at our store</h2>
<p>Just a heads-up on our hours over the holiday week — write these down or save this email!</p>
<table cellpadding="6" cellspacing="0" style="margin:16px 0;font-size:14px;border-collapse:collapse">
  <tr style="background:#f1f5f9"><td style="padding:8px 12px"><strong>Monday</strong></td><td style="padding:8px 12px">10am – 6pm</td></tr>
  <tr><td style="padding:8px 12px"><strong>Tuesday</strong></td><td style="padding:8px 12px">10am – 6pm</td></tr>
  <tr style="background:#f1f5f9"><td style="padding:8px 12px"><strong>Wednesday</strong></td><td style="padding:8px 12px">10am – 4pm <em>(early close)</em></td></tr>
  <tr><td style="padding:8px 12px"><strong>Thursday</strong></td><td style="padding:8px 12px"><em>Closed</em></td></tr>
  <tr style="background:#f1f5f9"><td style="padding:8px 12px"><strong>Friday</strong></td><td style="padding:8px 12px">10am – 6pm</td></tr>
  <tr><td style="padding:8px 12px"><strong>Saturday</strong></td><td style="padding:8px 12px">10am – 5pm</td></tr>
  <tr style="background:#f1f5f9"><td style="padding:8px 12px"><strong>Sunday</strong></td><td style="padding:8px 12px"><em>Closed</em></td></tr>
</table>
<p>Wishing you a happy and comfortable holiday season.</p>
<p>— <strong>The Foot Solutions Flower Mound team</strong></p>`,
  },

  // ── Loyalty / appreciation ────────────────────────────────────────
  {
    id: 'thank-you-loyalty',
    name: 'Thank-you note',
    emoji: '🙏',
    subject: 'Thank you for your loyalty',
    description: 'Pure thank-you email — no discount, no ask.',
    bestFor: 'opted in / repeat customers',
    bodyHtml: `<h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">Just a thank you</h2>
<p>No discount code, no big ask — just a quick note to say <strong>thank you</strong> for being one of our customers.</p>
<p>Small footwear stores like ours don't survive without loyal people who choose us over the big chains and online giants. Every visit, every fitting, every pair of orthotics — it adds up to a store that's still here, still doing what we love.</p>
<p>If there's anything we should be doing differently, please <a href="mailto:flowermound@footsolutions.com" style="color:#2563eb">drop us a note</a> — we read everything that comes in.</p>
<p>Thanks again,<br/>
<strong>Nancy, Justin, and the entire Foot Solutions Flower Mound team</strong></p>`,
  },

  // ── Blank / starter ───────────────────────────────────────────────
  {
    id: 'blank',
    name: 'Start from scratch',
    emoji: '✏️',
    subject: '',
    description: 'Write your own from a blank canvas.',
    bestFor: 'any',
    bodyHtml: '',
  },
];
