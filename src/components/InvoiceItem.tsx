/**
 * InvoiceItem — single invoice/bill in the Invoices & Bills card.
 *
 * Sibling of <FollowUpItem />: same Clear-button verify pattern but
 * sends `kind: "invoice"` to the backend so the model judges payment
 * closure ("paid?", "settled?", "vendor confirmed receipt?") rather
 * than generic conversation resolution.
 *
 * On `resolved` we hide the item via `onResolved`; on `unresolved` /
 * `inconclusive` we keep it visible with an amber disclaimer that
 * shows the model's reason and which model answered.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import api from '../lib/api';
import { gmailMessageUrl } from '../lib/gmailLinks';
import SourceAccountBadge from './SourceAccountBadge';

export interface Invoice {
  vendor: string;
  amount: number | null;
  dueDate: string | null;
  summary: string;
  sourceMessageId: string;
  sourceThreadId?: string;
  sourceAccount?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
}

interface VerifyResponse {
  verdict: 'resolved' | 'unresolved' | 'inconclusive';
  reason: string;
  verifiedAt: string;
  model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
}

export default function InvoiceItem({
  invoice,
  index,
  analysisGeneratedAt,
  onResolved,
  /** Compact rendering tweaks for the OwnerHome card. */
  compact = false,
}: {
  invoice: Invoice;
  /** Stable index in the parent list — used for the verdict cache key. */
  index: number;
  /** ISO timestamp of the original analysis run. */
  analysisGeneratedAt?: string;
  /** Callback invoked when verdict is "resolved" so the parent can hide. */
  onResolved: (index: number) => void;
  compact?: boolean;
}) {
  const [verdict, setVerdict] = useState<VerifyResponse | null>(null);

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const followUpId = `${analysisGeneratedAt ?? 'na'}-inv-${index}-${(invoice.vendor ?? '').slice(0, 60)}`;
      const sourceMessageIds = invoice.sourceMessageId ? [invoice.sourceMessageId] : [];
      const sourceThreadIds = invoice.sourceThreadId ? [invoice.sourceThreadId] : [];
      const res = await api.post<VerifyResponse>('/gmail/follow-up/verify', {
        followUpId,
        kind: 'invoice',
        title: invoice.vendor,
        why: invoice.summary,
        sourceMessageIds,
        sourceThreadIds,
        analysisGeneratedAt: analysisGeneratedAt ?? null,
        invoiceContext: {
          vendor: invoice.vendor,
          amount: invoice.amount,
          dueDate: invoice.dueDate,
        },
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

  const link = invoice.sourceThreadId ?? invoice.sourceMessageId;

  if (compact) {
    // Used by OwnerHome — boxed, dense layout that matches the card.
    return (
      <li className="border border-amber-100 bg-amber-50/40 rounded-lg p-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-slate-900 flex-1">
            {invoice.vendor}
            <SourceAccountBadge sourceAccount={invoice.sourceAccount} />
          </p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {invoice.amount != null && (
              <span className="text-sm font-bold text-amber-900 tabular-nums">
                ${invoice.amount.toFixed(2)}
              </span>
            )}
            <button
              type="button"
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending}
              className="text-[10px] text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300 rounded px-1.5 py-0.5 transition disabled:opacity-50 disabled:cursor-wait"
              title="Verify payment / closure before clearing — uses Sonnet 4.6 to read the latest replies."
            >
              {verifyMutation.isPending ? 'Checking…' : 'Clear'}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-600 mt-0.5">{invoice.summary}</p>
        <div className="flex items-center justify-between gap-2 mt-1">
          {invoice.dueDate && (
            <p className="text-[11px] text-amber-700">Due {invoice.dueDate}</p>
          )}
          {link && (
            <a
              href={gmailMessageUrl(link)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-amber-700 hover:underline inline-flex items-center gap-1 ml-auto"
            >
              Open in Gmail
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
        {verdict && (
          <div className="mt-2 px-2 py-1.5 rounded border border-amber-300 bg-amber-100 text-[11px] text-amber-900 leading-snug">
            <div className="font-medium">
              {verdict.verdict === 'unresolved'
                ? "Couldn't auto-clear: invoice still appears unpaid"
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

  // Full layout — used inside the GmailAnalysis page (matches existing
  // bordered-row look).
  return (
    <li className="flex items-start justify-between gap-3 py-2 border-b last:border-0 border-slate-100">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">
          {invoice.vendor}
          <SourceAccountBadge sourceAccount={invoice.sourceAccount} />
        </p>
        <p className="text-xs text-slate-600 mt-0.5">{invoice.summary}</p>
        {invoice.dueDate && (
          <p className="text-[11px] text-amber-700 mt-1">Due: {invoice.dueDate}</p>
        )}
        {link && (
          <a
            href={gmailMessageUrl(link)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-100 rounded px-1.5 py-0.5 transition mt-1.5"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            Open invoice
          </a>
        )}
        {verdict && (
          <div className="mt-2 px-2 py-1.5 rounded border border-amber-300 bg-amber-100 text-[11px] text-amber-900 leading-snug">
            <div className="font-medium">
              {verdict.verdict === 'unresolved'
                ? "Couldn't auto-clear: invoice still appears unpaid"
                : 'Verification inconclusive'}
            </div>
            <div className="text-amber-800">{verdict.reason}</div>
            <div className="text-[10px] text-amber-700/80 mt-0.5">
              Verified just now · {verdict.model}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        {invoice.amount != null && (
          <span className="text-sm font-semibold text-slate-900 whitespace-nowrap">
            ${invoice.amount.toFixed(2)}
          </span>
        )}
        <button
          type="button"
          onClick={() => verifyMutation.mutate()}
          disabled={verifyMutation.isPending}
          className="text-[10px] text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300 rounded px-1.5 py-0.5 transition disabled:opacity-50 disabled:cursor-wait"
          title="Verify payment / closure before clearing — uses Sonnet 4.6 to read the latest replies."
        >
          {verifyMutation.isPending ? 'Checking…' : 'Clear'}
        </button>
      </div>
    </li>
  );
}
