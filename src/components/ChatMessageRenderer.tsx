/**
 * ChatMessageRenderer — renders a chat assistant reply with inline Gmail links.
 *
 * Handles these patterns:
 * 1. Markdown links: [label](url) → rendered as clickable links
 * 2. Bare https:// URLs → rendered as clickable links
 * 3. "(msg 19e4210e213176eb)" citations → rendered as "Open in Gmail" links
 * 4. **bold** markdown → rendered as <strong>
 */

import { ExternalLink } from 'lucide-react';
import { gmailMessageUrl } from '../lib/gmailLinks';

// Matches markdown links: [label](url)
const MD_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

// Matches bare https:// URLs (stops at whitespace or common trailing punctuation)
// Must not be preceded by '](' to avoid double-matching markdown links
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

// Matches: (msg 19e4210e213176eb) or (thread 19e4210e213176eb)
const MSG_PATTERN = /\((?:msg|thread|message)\s+([0-9a-f]{10,20})\)/gi;

// Matches markdown bold: **text**
const BOLD_PATTERN = /\*\*(.+?)\*\*/g;

type Segment =
  | { type: 'text'; content: string }
  | { type: 'url'; href: string; label: string }
  | { type: 'mdlink'; href: string; label: string }
  | { type: 'msglink'; href: string; label: string }
  | { type: 'bold'; content: string };

function parseSegments(text: string): Segment[] {
  interface Match {
    index: number;
    length: number;
    segment: Segment;
  }
  const matches: Match[] = [];

  // 1. Markdown links [label](url) — parse FIRST so bare URL pass doesn't double-match
  let m: RegExpExecArray | null;
  MD_LINK_PATTERN.lastIndex = 0;
  while ((m = MD_LINK_PATTERN.exec(text)) !== null) {
    const label = m[1]!;
    const href = m[2]!.replace(/[.,;:!?]+$/, '');
    matches.push({
      index: m.index,
      length: m[0]!.length,
      segment: { type: 'mdlink', href, label },
    });
  }

  // 2. Bare https:// URLs (skip positions already claimed by markdown links)
  URL_PATTERN.lastIndex = 0;
  while ((m = URL_PATTERN.exec(text)) !== null) {
    let href = m[0]!.replace(/[.,;:!?)]+$/, '');
    // Skip if this URL is inside a markdown link already captured above
    const alreadyClaimed = matches.some(
      (existing) =>
        m!.index >= existing.index &&
        m!.index < existing.index + existing.length
    );
    if (!alreadyClaimed) {
      matches.push({
        index: m.index,
        length: href.length,
        segment: { type: 'url', href, label: href },
      });
    }
  }

  // 3. (msg XXXX) citations
  MSG_PATTERN.lastIndex = 0;
  while ((m = MSG_PATTERN.exec(text)) !== null) {
    const msgId = m[1]!;
    matches.push({
      index: m.index,
      length: m[0]!.length,
      segment: { type: 'msglink', href: gmailMessageUrl(msgId), label: m[0]! },
    });
  }

  // 4. **bold**
  BOLD_PATTERN.lastIndex = 0;
  while ((m = BOLD_PATTERN.exec(text)) !== null) {
    matches.push({
      index: m.index,
      length: m[0]!.length,
      segment: { type: 'bold', content: m[1]! },
    });
  }

  // Sort by position, remove overlaps (first match wins)
  matches.sort((a, b) => a.index - b.index);
  const nonOverlapping: Match[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index >= cursor) {
      nonOverlapping.push(match);
      cursor = match.index + match.length;
    }
  }

  // Build segments
  const segments: Segment[] = [];
  let pos = 0;
  for (const match of nonOverlapping) {
    if (match.index > pos) {
      segments.push({ type: 'text', content: text.slice(pos, match.index) });
    }
    segments.push(match.segment);
    pos = match.index + match.length;
  }
  if (pos < text.length) {
    segments.push({ type: 'text', content: text.slice(pos) });
  }

  return segments;
}

interface Props {
  content: string;
  className?: string;
  isUser?: boolean;
}

export default function ChatMessageRenderer({ content, className, isUser }: Props) {
  const segments = parseSegments(content);

  // If only plain text, render simply
  if (segments.every((s) => s.type === 'text')) {
    return <span className={className}>{content}</span>;
  }

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <span key={i}>{seg.content}</span>;
        }
        if (seg.type === 'bold') {
          return <strong key={i} className="font-semibold">{seg.content}</strong>;
        }
        // URL, mdlink, or msg link
        const href = (seg as { href: string }).href;
        const label = seg.type === 'mdlink'
          ? seg.label  // use the markdown label text
          : seg.type === 'msglink'
            ? seg.label
            : seg.label;
        const isGmail = href.includes('mail.google.com');
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={isGmail ? 'Open in Gmail' : href}
            className={`inline-flex items-center gap-0.5 underline underline-offset-2 font-medium transition-opacity hover:opacity-80 break-all ${
              isUser
                ? 'text-white/90 decoration-white/60'
                : 'text-blue-600 decoration-blue-300'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 inline" />
            {seg.type === 'mdlink'
              ? label
              : isGmail
                ? (seg.type === 'msglink' ? seg.label : 'Open in Gmail')
                : label}
          </a>
        );
      })}
    </span>
  );
}
