/**
 * FollowUpItem — single row in the Follow-ups Needed card.
 *
 * Shared between the full Gmail Analysis page and the curated OwnerHome
 * landing so the Clear-button verify behaviour is identical for admins
 * and non-admins (Reqs: any authenticated user can verify; backend is
 * the single source of truth).
 *
 * The Clear button POSTs to /gmail/follow-up/verify which:
 *   - resolves the actual Gmail thread(s) for the cited messages
 *   - fetches live thread state (cache fallback only)
 *   - returns one of: resolved | unresolved | inconclusive
 *
 * On `resolved` we hide the item via the parent's `onResolved` callback;
 * on the other two we keep it visible and render an amber disclaimer
 * with the model's reason.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import api from '../lib/api';
import { gmailMessageUrl } from '../lib/gmailLinks';
import SourceAccountBadge from './SourceAccountBadge';

export interface FollowUp {
  title: string;
  why: string;
  suggestedAction: string;
  urgency?: 'high' | 'medium' | 'low';
  sourceMessageIds: string[];
  sourceThreadIds?: string[];
  sourceAccount?: string;
}

interface VerifyResponse {
  verdict: 'resolved' | 'unresolved' | 'inconclusive';
  reason: string;
  verifiedAt: string;
  model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
}

interface Verdict extends VerifyResponse {}

const URGENCY_STYLES = {
  high: 'border-red-200 bg-red-50/60',
  medium: 'border-rose-100 bg-rose-50/40',
  low: 'border-slate-200 bg-slate-50/40',
} as const;

const URGENCY_BADGE = {
  high: { cls: 'bg-red-100 text-red-700', label: '🔴 High' },
  medium: { cls: 'bg-amber-100 text-amber-700', label: '🟡 Medium' },
  low: { cls: 'bg-slate-100 text-slate-500', label: '⚪ Low' },
} as const;

export default function FollowUpItem({
  followUp,
  index,
  analysisGeneratedAt,
  onResolved,
  showSubAction = true,
}: {
  followUp: FollowUp;
  /** Stable index in the parent list — used for the verdict cache key. */
  index: number;
  /** ISO timestamp of the original analysis run. */
  analysisGeneratedAt?: string;
  /** Callback invoked when the model returns "resolved" so the parent can hide the item. */
  onResolved: (index: number) => void;
  /** Whether to render the inline "→ suggested action" line. */
  showSubAction?: boolean;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const followUpId = `${analysisGeneratedAt ?? 'na'}-${index}-${(followUp.title ?? '').slice(0, 60)}`;
      const res = await api.post<VerifyResponse>('/gmail/follow-up/verify', {
        followUpId,
        title: followUp.title,
        why: followUp.why,
        sourceMessageIds: followUp.sourceMessageIds ?? [],
        sourceThreadIds: followUp.sourceThreadIds ?? [],
        analysisGeneratedAt: analysisGeneratedAt ?? null,
      });
      return res.data;
    },
    onSuccess: (data) => {
      if (data.verdict === 'resolved') {
        onResolved(index);
        setVerdict(null);
      } else {
        setVerdict(data);
      }
    },
  });

  const linkIds = followUp.sourceThreadIds ?? followUp.sourceMessageIds ?? [];
  const hasSingleId = linkIds.length === 1;
  const urgency = followUp.urgency;
  const urgencyStyle = URGENCY_STYLES[urgency ?? 'medium'];
  const urgencyBadge = URGENCY_BADGE[urgency ?? 'medium'];

  return (
    <li className={`border ${urgencyStyle} rounded-lg p-3`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-medium text-slate-900 flex-1">
          {followUp.title}
          <SourceAccountBadge sourceAccount={followUp.sourceAccount} />
        </p>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {urgency && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${urgencyBadge.cls}`}>
              {urgencyBadge.label}
            </span>
          )}
          <button
            type="button"
            onClick={() => verifyMutation.mutate()}
            disabled={verifyMutation.isPending}
            className="text-[10px] text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300 rounded px-1.5 py-0.5 transition disabled:opacity-50 disabled:cursor-wait"
            title="Verify this thread is resolved before clearing — uses Sonnet 4.6 to check the latest replies."
          >
            {verifyMutation.isPending ? 'Checking…' : 'Clear'}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-600">{followUp.why}</p>
      {showSubAction &&
        (hasSingleId ? (
          <a
            href={gmailMessageUrl(linkIds[0]!)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-rose-700 mt-1.5 font-medium hover:text-rose-900 hover:underline"
          >
            → {followUp.suggestedAction}
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <p className="text-xs text-rose-700 mt-1.5 font-medium">
            → {followUp.suggestedAction}
          </p>
        ))}
      {!hasSingleId && linkIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {linkIds.slice(0, 4).map((id, i) => (
            <a
              key={id}
              href={gmailMessageUrl(id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-100 rounded px-1.5 py-0.5 transition"
              title={`Open message ${id} in Gmail`}
            >
              <ExternalLink className="w-2.5 h-2.5" />
              Msg {i + 1}
            </a>
          ))}
        </div>
      )}
      {verdict && (
        <div className="mt-2 px-2 py-1.5 rounded border border-amber-200 bg-amber-50 text-[11px] text-amber-900 leading-snug">
          <div className="font-medium">
            {verdict.verdict === 'unresolved'
              ? "Couldn't auto-clear: still unresolved"
              : 'Verification inconclusive'}
          </div>
          <div className="text-amber-800">{verdict.reason}</div>
          <div className="text-[10px] text-amber-700/80 mt-0.5">
            Verified just now · {verdict.model}
          </div>
        </div>
      )}
    </li>
  );
}
