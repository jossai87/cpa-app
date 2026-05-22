/**
 * DailyHighlightsCard — three-section daily digest for the Sales Overview tab.
 *
 * Backed by /pos/daily-highlights (POST to start a run, GET to poll/read).
 * Cached 6 hours server-side; uses the same async self-invoke pattern as the
 * Gmail Analysis page so the 30s API GW timeout never bites.
 */

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles,
  Package,
  Building2,
  Users,
  RefreshCw,
  Loader2,
  AlertCircle,
  ExternalLink,
  Mail,
} from 'lucide-react';
import api from '../lib/api';
import { gmailMessageUrl } from '../lib/gmailLinks';

interface HighlightItem {
  title: string;
  detail: string;
  whyItMatters?: string;
  sourceMessageIds?: string[];
  /** Backend-resolved thread ids that match the messageIds 1:1. */
  sourceThreadIds?: string[];
  sourceUrls?: string[];
}

interface DailyHighlightsResponse {
  generatedAt: string;
  windowDays: number;
  vendors: HighlightItem[];
  network: { fromCorporate: HighlightItem[]; fromOtherStores: HighlightItem[] };
  customers: HighlightItem[];
  modelId: string;
  status?: 'ready' | 'running' | 'error' | 'none';
  runStartedAt?: string;
  lastError?: string | null;
  fromCache?: boolean;
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function HighlightList({
  items,
  emptyText,
  accentClass,
}: {
  items: HighlightItem[];
  emptyText: string;
  accentClass: string;
}) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">{emptyText}</p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className={`border-l-2 ${accentClass} pl-3 py-0.5`}>
          <p className="text-sm font-medium text-slate-900 leading-snug">{item.title}</p>
          <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{item.detail}</p>
          {item.whyItMatters && (
            <p className="text-[11px] text-slate-500 italic mt-0.5">
              Why it matters: {item.whyItMatters}
            </p>
          )}
          {(() => {
            const linkIds = item.sourceThreadIds ?? item.sourceMessageIds;
            if (!linkIds || linkIds.length === 0) return null;
            return (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <span className="text-[10px] text-slate-400 flex items-center gap-1">
                  <Mail className="w-2.5 h-2.5" />
                  Source:
                </span>
                {linkIds.slice(0, 4).map((id, j) => (
                  <a
                    key={id}
                    href={gmailMessageUrl(id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[10px] text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-100 rounded px-1 py-0.5 transition"
                    title={`Open thread ${id} in Gmail`}
                  >
                    <ExternalLink className="w-2 h-2" />
                    {linkIds.length === 1 ? 'open' : `${j + 1}`}
                  </a>
                ))}
                {linkIds.length > 4 && (
                  <span className="text-[10px] text-slate-400">
                    +{linkIds.length - 4}
                  </span>
                )}
              </div>
            );
          })()}
          {item.sourceUrls && item.sourceUrls.length > 0 && (
            <ul className="text-[10px] text-blue-600 mt-1 space-y-0.5">
              {item.sourceUrls.map((u, j) => (
                <li key={j} className="flex items-center gap-1 truncate">
                  <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                  <a
                    href={u}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline truncate"
                  >
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function DailyHighlightsCard() {
  const queryClient = useQueryClient();

  const q = useQuery<DailyHighlightsResponse>({
    queryKey: ['pos', 'daily-highlights'],
    queryFn: async () => {
      try {
        return (await api.get<DailyHighlightsResponse>('/pos/daily-highlights')).data;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        // 404 is the "no row yet" case — return synthetic empty so the
        // useEffect below can kick a generation. Any other status (401, 500,
        // etc.) we let propagate so React Query exposes q.isError and we
        // render an explicit error state instead of looping.
        if (status === 404) {
          return {
            generatedAt: '',
            windowDays: 2,
            vendors: [],
            network: { fromCorporate: [], fromOtherStores: [] },
            customers: [],
            modelId: '',
            status: 'none',
          } as DailyHighlightsResponse;
        }
        throw err;
      }
    },
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 4000 : false),
    staleTime: 30 * 1000,
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: (refresh: boolean) =>
      api
        .post<DailyHighlightsResponse>('/pos/daily-highlights', { refresh })
        .then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pos', 'daily-highlights'] });
    },
  });

  const data = q.data;
  const status = data?.status ?? 'none';
  const isRunning = status === 'running' || startMutation.isPending;
  // Defensive: a cached row in "running" or "error" state may not yet have
  // the vendors / customers / network arrays populated. Default to empty
  // arrays before any .length / .map calls to keep the page from crashing.
  const vendors = data?.vendors ?? [];
  const customers = data?.customers ?? [];
  const fromCorporate = data?.network?.fromCorporate ?? [];
  const fromOtherStores = data?.network?.fromOtherStores ?? [];
  const hasContent =
    vendors.length > 0 ||
    customers.length > 0 ||
    fromCorporate.length > 0 ||
    fromOtherStores.length > 0;

  // Auto-kick a run when there's no cached row yet. Using useEffect (not a
  // raw render-time call) avoids the infinite-loop hazard where mutate()
  // fires every render until pending state catches up.
  useEffect(() => {
    if (
      !q.isLoading &&
      !q.isError &&
      !hasContent &&
      !isRunning &&
      status === 'none' &&
      !startMutation.isError
    ) {
      startMutation.mutate(false);
    }
    // We deliberately don't include startMutation in the deps because the
    // useMutation object identity changes every render; we only want this
    // to react to query state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isLoading, q.isError, hasContent, isRunning, status, startMutation.isError]);

  return (
    <section className="bg-gradient-to-br from-rose-50/50 via-white to-amber-50/30 rounded-xl border border-slate-200 p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-rose-100 text-rose-700">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Daily Highlights</h2>
          <p className="text-[11px] text-slate-500">
            Last {data?.windowDays ?? 2} days · email signals + market context
            {data?.generatedAt && ` · ${timeAgo(data.generatedAt)}`}
          </p>
        </div>
        <button
          onClick={() => startMutation.mutate(true)}
          disabled={isRunning}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition"
        >
          {isRunning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </div>

      {q.isLoading && !data && (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}

      {q.isError && !data && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Could not load highlights:{' '}
            {(q.error as Error)?.message ?? 'Unknown error.'}
          </span>
        </div>
      )}

      {startMutation.isError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Could not start a new run:{' '}
            {(startMutation.error as Error)?.message ?? 'Unknown error.'}
          </span>
        </div>
      )}

      {isRunning && !hasContent && (
        <div className="flex items-center gap-2 text-sm text-slate-600 py-6">
          <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
          Reading inbox + searching the web for context…
        </div>
      )}

      {status === 'error' && !isRunning && data?.lastError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>Last run failed: {data.lastError}</span>
        </div>
      )}

      {hasContent && data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Vendors */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Package className="w-3.5 h-3.5 text-emerald-600" />
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Vendors
              </h3>
              <span className="text-[10px] text-slate-400">({vendors.length})</span>
            </div>
            <HighlightList
              items={vendors}
              emptyText="Nothing notable from vendors."
              accentClass="border-emerald-300"
            />
          </div>

          {/* Network (HQ + sister stores) */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Building2 className="w-3.5 h-3.5 text-blue-600" />
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Network
              </h3>
              <span className="text-[10px] text-slate-400">
                ({fromCorporate.length + fromOtherStores.length})
              </span>
            </div>
            {fromCorporate.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                  From HQ
                </p>
                <HighlightList
                  items={fromCorporate}
                  emptyText=""
                  accentClass="border-blue-300"
                />
              </div>
            )}
            {fromOtherStores.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1">
                  Sister stores
                </p>
                <HighlightList
                  items={fromOtherStores}
                  emptyText=""
                  accentClass="border-indigo-300"
                />
              </div>
            )}
            {fromCorporate.length === 0 &&
              fromOtherStores.length === 0 && (
                <p className="text-xs text-slate-400 italic">
                  Quiet day from HQ and sister stores.
                </p>
              )}
          </div>

          {/* Customers */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Users className="w-3.5 h-3.5 text-purple-600" />
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Customers
              </h3>
              <span className="text-[10px] text-slate-400">({customers.length})</span>
            </div>
            <HighlightList
              items={customers}
              emptyText="No customer threads needing attention."
              accentClass="border-purple-300"
            />
          </div>
        </div>
      )}
    </section>
  );
}
