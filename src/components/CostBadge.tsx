/**
 * CostBadge — admin-only AWS cost tracker.
 *
 * Shows a pill-shaped badge with the current month-to-date AWS spend for
 * the application. Click it to open a modal with per-service breakdown.
 *
 * Visible only when the signed-in user is the admin (jandoossai@gmail.com).
 * Backed by GET /admin/aws-costs which calls AWS Cost Explorer with caching.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign, RefreshCcw, X, Loader2, AlertCircle } from 'lucide-react';
import api from '../lib/api';
import { useAdmin } from '../lib/admin';

interface AwsCostSummary {
  generatedAt: string;
  monthToDateTotal: number;
  last30DaysTotal: number;
  currency: string;
  monthStart: string;
  monthEnd: string;
  byService: Array<{ service: string; cost: number }>;
  filteredByTag: boolean;
  notes?: string;
  fromCache?: boolean;
}

function fmtUSD(n: number): string {
  if (n < 0.01) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtRelativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function CostBadge() {
  const { isAdmin } = useAdmin();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const costsQ = useQuery<AwsCostSummary>({
    queryKey: ['admin', 'aws-costs'],
    queryFn: () => api.get<AwsCostSummary>('/admin/aws-costs').then((r) => r.data),
    enabled: isAdmin,
    staleTime: 12 * 60 * 60 * 1000, // 12 hours
    refetchOnWindowFocus: false,
  });

  // Global ESC handler — also fires when focus is outside the dialog,
  // which is what was making the modal feel "stuck" with no close path.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!isAdmin) return null;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await api.get<AwsCostSummary>('/admin/aws-costs?refresh=true');
      void costsQ.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  const data = costsQ.data;
  const isLoading = costsQ.isLoading;
  const isError = costsQ.isError;

  return (
    <>
      {/* Pill badge */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 hover:border-emerald-300 transition-colors"
        aria-label="AWS costs"
        title="AWS costs — month-to-date AWS spend for this app (admin only). Click for the per-service breakdown."
      >
        <DollarSign className="w-4 h-4" aria-hidden="true" />
        {isLoading ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : isError || !data ? (
          <span className="text-amber-700">—</span>
        ) : (
          <span className="font-semibold tabular-nums">{fmtUSD(data.monthToDateTotal)}</span>
        )}
        <span className="text-[10px] text-emerald-600 hidden sm:inline">MTD</span>
      </button>

      {/* Modal */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cost-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
          tabIndex={-1}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col overflow-hidden" style={{ maxHeight: 'min(85vh, calc(100vh - 2rem))' }}>
            {/* Header */}
            <div className="flex-shrink-0 px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-white">
              <div className="flex items-center gap-2 min-w-0">
                <DollarSign className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                <div className="min-w-0">
                  <h2 id="cost-modal-title" className="text-base font-semibold text-slate-900">AWS Cost Tracker</h2>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">
                    {data?.fromCache && data.generatedAt
                      ? <>Cached · last refreshed {fmtRelativeTime(data.generatedAt)}</>
                      : 'Live from AWS Cost Explorer'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <button
                  onClick={() => void handleRefresh()}
                  disabled={refreshing}
                  className="text-slate-500 hover:text-slate-800 disabled:opacity-50 p-1"
                  aria-label="Refresh"
                  title="Refresh from AWS (costs ~$0.01 per call)"
                >
                  <RefreshCcw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5"
                  aria-label="Close"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading cost data…
                </div>
              ) : isError || !data ? (
                <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Unable to load cost data.</p>
                    <p className="text-xs text-red-600 mt-1">
                      Cost Explorer needs to be enabled in your AWS account, and the IAM role needs
                      <code className="bg-red-100 px-1 rounded">ce:GetCostAndUsage</code>.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Top stats */}
                  <div className="grid grid-cols-2 gap-3 mb-5">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-medium">Month to date</p>
                      <p className="text-2xl font-bold text-emerald-900 mt-1 tabular-nums">{fmtUSD(data.monthToDateTotal)}</p>
                      <p className="text-[10px] text-emerald-600 mt-0.5">{data.monthStart} → today</p>
                    </div>
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                      <p className="text-[10px] uppercase tracking-wide text-blue-700 font-medium">Last 30 days</p>
                      <p className="text-2xl font-bold text-blue-900 mt-1 tabular-nums">{fmtUSD(data.last30DaysTotal)}</p>
                      <p className="text-[10px] text-blue-600 mt-0.5">rolling window</p>
                    </div>
                  </div>

                  {/* Notes (e.g. tag not activated) */}
                  {data.notes && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-4 text-[11px] text-amber-800">
                      {data.notes}
                    </div>
                  )}

                  {/* Per-service breakdown */}
                  <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">
                    Month-to-date by service
                    {data.filteredByTag && (
                      <span className="ml-2 text-[9px] text-emerald-600 normal-case font-normal">
                        ✓ scoped to Project tag
                      </span>
                    )}
                  </h3>
                  {data.byService.length === 0 ? (
                    <p className="text-xs text-slate-500 italic">No costs incurred yet this month.</p>
                  ) : (
                    <div className="space-y-1">
                      {data.byService.map((s) => {
                        const pct = data.monthToDateTotal > 0
                          ? (s.cost / data.monthToDateTotal) * 100
                          : 0;
                        return (
                          <div key={s.service} className="flex items-center gap-2 text-xs">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-0.5">
                                <span className="text-slate-700 truncate" title={s.service}>{s.service}</span>
                                <span className="font-medium text-slate-800 tabular-nums ml-2">{fmtUSD(s.cost)}</span>
                              </div>
                              <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-emerald-500"
                                  style={{ width: `${Math.max(pct, 1)}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 px-6 py-3 border-t border-slate-100 bg-white flex items-center justify-between gap-3">
              <p className="text-[10px] text-slate-400 flex-1 leading-tight">
                Data from AWS Cost Explorer. Refreshed every 12h or manually (~$0.01/refresh).
                Costs are <strong>unblended</strong> — actual AWS charges before discounts.
              </p>
              <button
                onClick={() => setOpen(false)}
                className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
