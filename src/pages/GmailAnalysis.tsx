import { useState, useEffect } from 'react';
import { AttachmentRow } from '../components/AttachmentChip';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Mail,
  RefreshCw,
  Loader2,
  AlertCircle,
  Calendar,
  Package,
  Receipt,
  MessageSquare,
  ListTodo,
  TrendingUp,
  Clock,
  Database,
  CloudDownload,
  ExternalLink,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { gmailMessageUrl, gmailSearchUrl } from '../lib/gmailLinks';
import CentralTimeBadge from '../components/CentralTimeBadge';
import AccountGroupedList from '../components/AccountGroupedList';
// GmailChat removed at FS Assistant cutover (Task 18.2). Component file
// kept in src/components/GmailChat.tsx for the one-release rollback
// window per Req 10.2 — delete after the 14-day soak (Phase 5).

// ── Types (mirror lambda/gmail-analysis/index.ts) ─────────────────────

interface GmailEvent {
  title: string;
  date: string | null;
  location: string | null;
  contactName: string | null;
  contactEmail: string | null;
  summary: string;
  sourceMessageIds: string[];
  /** Backend-resolved thread ids that match the messageIds 1:1. */
  sourceThreadIds?: string[];
}
interface GmailVendor {
  name: string;
  messageCount: number;
  topics: string[];
  actionItems?: string[];
  sourceMessageIds: string[];
  sourceThreadIds?: string[];
}
interface GmailInvoice {
  vendor: string;
  amount: number | null;
  dueDate: string | null;
  summary: string;
  sourceMessageId: string;
  sourceThreadId?: string;
  /** Attachment metadata — populated when the cached message has attachments */
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  sourceAccount?: string;
}
interface GmailInquiry {
  from: string;
  subject: string;
  date: string;
  priority: 'high' | 'medium' | 'low';
  summary: string;
  sourceMessageId: string;
  sourceThreadId?: string;
  /** Attachment metadata — populated when the cached message has attachments */
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}
interface GmailFollowUp {
  title: string;
  why: string;
  suggestedAction: string;
  urgency?: 'high' | 'medium' | 'low';
  sourceMessageIds: string[];
  sourceThreadIds?: string[];
  sourceAccount?: string;
}
interface AnalysisResponse {
  overview: string;
  events: GmailEvent[];
  vendors: GmailVendor[];
  invoices: GmailInvoice[];
  customerInquiries: GmailInquiry[];
  followUpsNeeded: GmailFollowUp[];
  topSenders: Array<{ from: string; count: number }>;
  generatedAt: string;
  rangeDays: number;
  totalMessagesScanned: number;
  modelId: string;
  fromCache?: boolean;
  /** Server-persisted IDs cleared via verify-on-clear. Used to hydrate
   * the local "dismissed" sets so a refresh doesn't unhide cleared
   * items. Empty when the analysis is fresh / no items have been
   * cleared yet. */
  dismissedFollowUpIds?: string[];
  dismissedInvoiceIds?: string[];
}

const RANGE_OPTIONS = [7, 14, 30, 90, 180] as const;

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function priorityClass(p: GmailInquiry['priority']): string {
  if (p === 'high') return 'bg-red-100 text-red-700 border-red-200';
  if (p === 'medium') return 'bg-amber-100 text-amber-700 border-amber-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

// ── Reusable section header ───────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  count,
  iconClass,
}: {
  icon: typeof Mail;
  title: string;
  count: number;
  iconClass: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${iconClass}`}>
        <Icon className="w-4 h-4" />
      </div>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">{count}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-sm text-slate-500 italic px-4 py-3 bg-slate-50 rounded-lg border border-slate-100">
      {message}
    </div>
  );
}

/**
 * Inline list of Gmail deep links — used wherever the model returns
 * `sourceMessageIds`. Renders as discreet chips so they don't dominate
 * the section but are obvious as "open in Gmail" affordances.
 */
function MessageLinks({
  ids,
  label = 'Open in Gmail',
}: {
  ids: string[] | undefined;
  label?: string;
}) {
  if (!ids || ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {ids.slice(0, 6).map((id, i) => (
        <a
          key={id}
          href={gmailMessageUrl(id)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-100 rounded px-1.5 py-0.5 transition"
          title={`Open message ${id} in Gmail`}
        >
          <ExternalLink className="w-2.5 h-2.5" />
          {ids.length === 1 ? label : `Msg ${i + 1}`}
        </a>
      ))}
      {ids.length > 6 && (
        <span className="text-[10px] text-slate-400 self-center">
          +{ids.length - 6} more
        </span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

interface CacheStats {
  totalCanonical: number;
  oldestDate: string | null;
  newestDate: string | null;
  byKind: Record<string, number>;
}

interface SyncResult {
  mode: string;
  messagesSeen: number;
  messagesWritten: number;
  messagesSkipped: number;
  durationMs: number;
  truncated: boolean;
}

type AnalysisStatus = 'ready' | 'running' | 'error' | 'none';

// All AnalysisResponse fields are optional here because the cached row
// may exist in a "running" or "error" state without yet having data.
type AnalysisStateResponse = {
  [K in keyof AnalysisResponse]?: AnalysisResponse[K];
} & {
  status?: AnalysisStatus;
  runStartedAt?: string;
  runEndedAt?: string;
  lastError?: string | null;
  message?: string;
};

export default function GmailAnalysis() {
  const queryClient = useQueryClient();

  // GET /gmail/analyze — reads whatever's in the cache (ready, running, or error).
  // Poll every 4 seconds while a run is in flight; otherwise idle.
  // Long staleTime + gcTime so navigating away and back doesn't refetch /
  // re-analyze. Re-analyze only runs when the user clicks the button.
  const analysisQ = useQuery<AnalysisStateResponse>({
    queryKey: ['gmail', 'analyze'],
    queryFn: async () => {
      try {
        return (await api.get<AnalysisStateResponse>('/gmail/analyze')).data;
      } catch (err: unknown) {
        // 404 = no analysis cached yet
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) return { status: 'none' };
        throw err;
      }
    },
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.status === 'running' ? 4000 : false;
    },
    staleTime: 30 * 60 * 1000, // 30 min — persist across page navigation
    gcTime: 60 * 60 * 1000, // 60 min — keep in memory long after unmount
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Default the days selector to whatever range is already cached on the
  // server. Falls back to 14 on first load. This means navigating back to
  // the page won't trigger a "different range" auto-kick.
  const [days, setDays] = useState<number>(() => analysisQ.data?.rangeDays ?? 14);
  // Track follow-up items dismissed by the user (by index within the current analysis).
  // Resets when a new analysis runs. The note in the UI explains they'll reappear
  // on the next scan if still unresolved.
  const [dismissedFollowUps, setDismissedFollowUps] = useState<Set<number>>(new Set());

  /**
   * Verify-on-clear results. When the user clicks Clear we don't just
   * dismiss locally — we ask Bedrock whether the thread actually wraps
   * up the issue. If the verdict is "unresolved" or "inconclusive" we
   * keep the item visible and stash the reason here for display.
   *
   * Keyed by the same `i` (sort-order index) used by `dismissedFollowUps`.
   */
  const [verifyVerdicts, setVerifyVerdicts] = useState<
    Record<
      number,
      {
        verdict: 'resolved' | 'unresolved' | 'inconclusive';
        reason: string;
        verifiedAt: string;
        model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
      }
    >
  >({});

  /** Per-item Clear-button spinner state. */
  const [verifyingIndex, setVerifyingIndex] = useState<number | null>(null);

  // Same state shape but for invoices. Kept separate so the two cards
  // can be cleared independently and don't share index ranges.
  const [dismissedInvoices, setDismissedInvoices] = useState<Set<number>>(new Set());
  const [verifyInvoiceVerdicts, setVerifyInvoiceVerdicts] = useState<
    Record<
      number,
      {
        verdict: 'resolved' | 'unresolved' | 'inconclusive';
        reason: string;
        verifiedAt: string;
        model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
      }
    >
  >({});
  const [verifyingInvoiceIndex, setVerifyingInvoiceIndex] = useState<number | null>(null);

  // Reset dismissed items when a fresh analysis lands. The server-side
  // dismissed set is keyed by analysisGeneratedAt so we always start
  // from clean local state, then layer the server's persisted IDs on
  // in the next effect.
  useEffect(() => {
    setDismissedFollowUps(new Set());
    setVerifyVerdicts({});
    setVerifyingIndex(null);
    setDismissedInvoices(new Set());
    setVerifyInvoiceVerdicts({});
    setVerifyingInvoiceIndex(null);
  }, [analysisQ.data?.generatedAt]);

  // Hydrate dismissed sets from the server-persisted IDs. Convert the
  // server's id-strings (`${generatedAt}-${index}-${title.slice(0,60)}`)
  // back into local indices by recomputing them in the same sort order
  // the UI uses to render. Without this, refreshing the page brings
  // cleared items back.
  useEffect(() => {
    const data = analysisQ.data;
    if (!data?.generatedAt) return;
    const followUpIds = new Set(data.dismissedFollowUpIds ?? []);
    const invoiceIds = new Set(data.dismissedInvoiceIds ?? []);
    if (followUpIds.size === 0 && invoiceIds.size === 0) return;

    const order = { high: 0, medium: 1, low: 2, undefined: 1 } as const;
    const fuSorted = [...(data.followUpsNeeded ?? [])].sort((a, b) => {
      return (
        (order[a?.urgency ?? 'undefined'] ?? 1) -
        (order[b?.urgency ?? 'undefined'] ?? 1)
      );
    });
    const newFu = new Set<number>();
    fuSorted.forEach((f, i) => {
      const id = `${data.generatedAt}-${i}-${(f?.title ?? '').slice(0, 60)}`;
      if (followUpIds.has(id)) newFu.add(i);
    });
    if (newFu.size > 0) setDismissedFollowUps(newFu);

    const newInv = new Set<number>();
    (data.invoices ?? []).forEach((inv, i) => {
      const id = `${data.generatedAt}-inv-${i}-${(inv?.vendor ?? '').slice(0, 60)}`;
      if (invoiceIds.has(id)) newInv.add(i);
    });
    if (newInv.size > 0) setDismissedInvoices(newInv);
  }, [analysisQ.data]);
  // If the server returns a cached range later than the initial render,
  // sync the selector once so the UI matches what's actually displayed.
  useEffect(() => {
    if (analysisQ.data?.rangeDays && analysisQ.data.rangeDays !== days) {
      setDays(analysisQ.data.rangeDays);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisQ.data?.rangeDays]);

  const cacheStatsQ = useQuery<CacheStats>({
    queryKey: ['gmail', 'cache-stats'],
    queryFn: () => api.get<CacheStats>('/gmail/cache-stats').then((r) => r.data),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  // POST starts a background run. Server returns 202 with status: 'running'.
  // The polling GET above will pick up the result when it lands.
  const startRunMutation = useMutation({
    mutationFn: (refresh: boolean) =>
      api
        .post<AnalysisStateResponse>('/gmail/analyze', { days, refresh })
        .then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gmail', 'analyze'] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (mode: 'incremental' | 'backfill') =>
      api
        .post<SyncResult>('/gmail/sync', mode === 'backfill' ? { mode, months: 6 } : { mode })
        .then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gmail', 'cache-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['gmail', 'analyze'] });
    },
  });

  /**
   * Verify-on-Clear. Hits POST /gmail/follow-up/verify which decides if
   * the thread is actually resolved. On "resolved" we dismiss locally;
   * on "unresolved" / "inconclusive" we keep the item visible and stash
   * the reason for the disclaimer banner.
   *
   * Cost: ≤$0.02/click (short-circuit free; Haiku ~$0.002; Sonnet ~$0.015).
   */
  const verifyFollowUpMutation = useMutation({
    mutationFn: async (params: {
      index: number;
      followUp: GmailFollowUp;
      analysisGeneratedAt: string | undefined;
    }) => {
      const { index, followUp, analysisGeneratedAt } = params;
      const followUpId = `${analysisGeneratedAt ?? 'na'}-${index}-${(followUp.title ?? '').slice(0, 60)}`;
      const res = await api.post<{
        verdict: 'resolved' | 'unresolved' | 'inconclusive';
        reason: string;
        verifiedAt: string;
        model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
      }>('/gmail/follow-up/verify', {
        followUpId,
        title: followUp.title,
        why: followUp.why,
        sourceMessageIds: followUp.sourceMessageIds ?? [],
        sourceThreadIds: followUp.sourceThreadIds ?? [],
        analysisGeneratedAt: analysisGeneratedAt ?? null,
      });
      return { ...res.data, index };
    },
    onMutate: ({ index }) => {
      setVerifyingIndex(index);
    },
    onSettled: () => {
      setVerifyingIndex(null);
    },
    onSuccess: (data) => {
      const { index, verdict } = data;
      if (verdict === 'resolved') {
        setDismissedFollowUps((prev) => new Set([...prev, index]));
        // Drop any prior unresolved/inconclusive verdict for this index.
        setVerifyVerdicts((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      } else {
        setVerifyVerdicts((prev) => ({
          ...prev,
          [index]: {
            verdict: data.verdict,
            reason: data.reason,
            verifiedAt: data.verifiedAt,
            model: data.model,
          },
        }));
      }
    },
  });

  /**
   * Same Verify-on-Clear pattern as follow-ups, but tuned for invoice
   * closure (sends `kind: "invoice"` to the backend so the model checks
   * payment / settlement language rather than generic conversation
   * resolution).
   */
  const verifyInvoiceMutation = useMutation({
    mutationFn: async (params: {
      index: number;
      invoice: GmailInvoice;
      analysisGeneratedAt: string | undefined;
    }) => {
      const { index, invoice, analysisGeneratedAt } = params;
      const followUpId = `${analysisGeneratedAt ?? 'na'}-inv-${index}-${(invoice.vendor ?? '').slice(0, 60)}`;
      const sourceMessageIds = invoice.sourceMessageId ? [invoice.sourceMessageId] : [];
      const sourceThreadIds = invoice.sourceThreadId ? [invoice.sourceThreadId] : [];
      const res = await api.post<{
        verdict: 'resolved' | 'unresolved' | 'inconclusive';
        reason: string;
        verifiedAt: string;
        model: 'sonnet-4.6' | 'haiku-4.5' | 'short-circuit';
      }>('/gmail/follow-up/verify', {
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
      return { ...res.data, index };
    },
    onMutate: ({ index }) => {
      setVerifyingInvoiceIndex(index);
    },
    onSettled: () => {
      setVerifyingInvoiceIndex(null);
    },
    onSuccess: (data) => {
      const { index, verdict } = data;
      if (verdict === 'resolved') {
        setDismissedInvoices((prev) => new Set([...prev, index]));
        setVerifyInvoiceVerdicts((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      } else {
        setVerifyInvoiceVerdicts((prev) => ({
          ...prev,
          [index]: {
            verdict: data.verdict,
            reason: data.reason,
            verifiedAt: data.verifiedAt,
            model: data.model,
          },
        }));
      }
    },
  });

  // Auto-kick a run ONLY if there's no cached analysis at all (first-time
  // user). If a previous run exists for a different range, just show it —
  // the user can click Re-analyze when they want fresh data. This prevents
  // the page from triggering a costly re-analyze every time the user
  // navigates away and back.
  const status = analysisQ.data?.status ?? 'none';
  const needsRun =
    !analysisQ.isLoading &&
    !analysisQ.isError &&
    !startRunMutation.isPending &&
    !startRunMutation.isError &&
    status === 'none';

  // Auto-kick a run if there's nothing cached, or if the cached result is for
  // a different range than the user just selected. useEffect (not a raw
  // render-time call) avoids the infinite-loop hazard.
  useEffect(() => {
    if (needsRun) {
      startRunMutation.mutate(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRun]);

  const data = analysisQ.data;
  const isResultReady =
    !!data && data.status !== 'running' && Array.isArray(data.events);
  const isRunning = status === 'running' || startRunMutation.isPending;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="app-header px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to="/"
              className="btn-ghost px-2"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <div className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-rose-600" />
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">Gmail Assistant</h1>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <CentralTimeBadge />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Cache status banner */}
        {cacheStatsQ.data && (
          <div className="mb-4 flex flex-wrap items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-600" />
              <span className="text-xs font-medium text-slate-700">Cache:</span>
            </div>
            {cacheStatsQ.data.totalCanonical === 0 ? (
              <span className="text-xs text-amber-700">
                Empty — run a backfill to enable fast inbox queries.
              </span>
            ) : (
              <>
                <span className="text-xs text-slate-700">
                  {cacheStatsQ.data.totalCanonical.toLocaleString()} messages
                </span>
                <span className="text-xs text-slate-400">·</span>
                <span className="text-xs text-slate-700">
                  {cacheStatsQ.data.oldestDate ?? '—'} → {cacheStatsQ.data.newestDate ?? '—'}
                </span>
                {cacheStatsQ.data.byKind && (
                  <span className="text-xs text-slate-500 hidden sm:inline">
                    ({Object.entries(cacheStatsQ.data.byKind)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')})
                  </span>
                )}
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => syncMutation.mutate('incremental')}
                disabled={syncMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition"
              >
                {syncMutation.isPending && syncMutation.variables === 'incremental' ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Sync now
              </button>
              {(!cacheStatsQ.data ||
                cacheStatsQ.data.totalCanonical === 0 ||
                (cacheStatsQ.data.oldestDate &&
                  cacheStatsQ.data.oldestDate >
                    new Date(Date.now() - 150 * 86400 * 1000).toISOString().slice(0, 10))) && (
                <button
                  onClick={() => syncMutation.mutate('backfill')}
                  disabled={syncMutation.isPending}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition"
                >
                  {syncMutation.isPending && syncMutation.variables === 'backfill' ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <CloudDownload className="w-3 h-3" />
                  )}
                  Backfill 6 months
                </button>
              )}
            </div>
          </div>
        )}

        {syncMutation.isSuccess && syncMutation.data && (
          <div className="mb-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            Sync complete: {syncMutation.data.messagesWritten} new,{' '}
            {syncMutation.data.messagesSkipped} already cached,{' '}
            {syncMutation.data.messagesSeen} seen ·{' '}
            {(syncMutation.data.durationMs / 1000).toFixed(1)}s
            {syncMutation.data.truncated && (
              <span className="ml-2 text-amber-700">
                (capped — run again to continue)
              </span>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt}
                onClick={() => setDays(opt)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  days === opt
                    ? 'bg-rose-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Last {opt} days
              </button>
            ))}
          </div>
          <button
            onClick={() => startRunMutation.mutate(true)}
            disabled={isRunning}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            {isRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Re-analyze
          </button>
          {data?.generatedAt && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500 ml-auto">
              <Clock className="w-3.5 h-3.5" />
              {isRunning ? 'Running · ' : 'Cached · '}
              {formatDateTime(data.generatedAt)} · {data.totalMessagesScanned ?? 0} msgs scanned
            </div>
          )}
        </div>

        {/* Running banner — shown while a fresh run is in flight */}
        {isRunning && (
          <div className="mb-4 flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
            <Loader2 className="w-4 h-4 text-rose-600 animate-spin flex-shrink-0" />
            <div className="text-xs text-rose-800">
              <span className="font-medium">Reading your inbox…</span>{' '}
              {data?.events
                ? 'Showing the previous result while the new one is generated.'
                : 'First run takes ~30–90 seconds.'}
            </div>
          </div>
        )}

        {/* Loading state — only when we have no prior data to show */}
        {isRunning && !isResultReady && (
          <div className="bg-white rounded-xl border border-slate-200 p-12 flex flex-col items-center justify-center">
            <Loader2 className="w-8 h-8 text-rose-600 animate-spin mb-3" />
            <p className="text-sm text-slate-600">Reading your inbox…</p>
            <p className="text-xs text-slate-400 mt-1">
              The model reads cached email metadata and pulls bodies as needed.
            </p>
          </div>
        )}

        {/* Error from a failed background run */}
        {status === 'error' && !isRunning && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 mb-4">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-900">Last analysis failed</p>
              <p className="text-xs text-red-700 mt-1">
                {data?.lastError ?? 'Unknown error.'}
              </p>
              <button
                onClick={() => startRunMutation.mutate(true)}
                className="text-xs text-red-700 underline mt-2 hover:text-red-900"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Network error fetching the cache state */}
        {analysisQ.isError && !data && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-900">Could not load analysis</p>
              <p className="text-xs text-red-700 mt-1">
                {(analysisQ.error as Error)?.message ?? 'Unknown error.'}
              </p>
            </div>
          </div>
        )}

        {/* Results */}
        {(() => {
          if (!data || !isResultReady) return null;
          // We've established by isResultReady that the analysis arrays are populated.
          const result = data as Required<Pick<
            AnalysisResponse,
            'overview' | 'events' | 'vendors' | 'invoices' | 'customerInquiries' |
            'followUpsNeeded' | 'topSenders' | 'totalMessagesScanned' | 'generatedAt'
          >>;
          return (
          <div className="space-y-6">
            {/* Overview */}
            <section className="bg-white rounded-xl border border-slate-200 p-5">
              <SectionHeader
                icon={TrendingUp}
                title="Overview"
                count={result.totalMessagesScanned}
                iconClass="bg-rose-100 text-rose-700"
              />
              <p className="text-sm text-slate-700 leading-relaxed">{result.overview}</p>
            </section>

            {/* Row 2: Follow-ups + Invoices side-by-side. Both are
                action-oriented sections the owner needs to triage first. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Follow-ups Needed */}
              <section className="bg-white rounded-xl border border-slate-200 p-5">
                <SectionHeader
                  icon={ListTodo}
                  title="Follow-ups Needed"
                  count={result.followUpsNeeded.length}
                  iconClass="bg-rose-100 text-rose-700"
                />
                {result.followUpsNeeded.length === 0 ? (
                  <EmptyState message="Inbox is clear — no obvious follow-ups." />
                ) : (
                  <>
                  <AccountGroupedList
                    items={[...result.followUpsNeeded].sort((a, b) => {
                      const order = { high: 0, medium: 1, low: 2, undefined: 1 };
                      return (order[a.urgency ?? 'undefined'] ?? 1) - (order[b.urgency ?? 'undefined'] ?? 1);
                    })}
                    getAccount={(f) => f.sourceAccount}
                  >
                    {(f, i) => {
                      if (dismissedFollowUps.has(i)) return null;
                      const linkIds = f.sourceThreadIds ?? f.sourceMessageIds ?? [];
                      const hasSingleId = linkIds.length === 1;
                      const urgencyStyle = f.urgency === 'high'
                        ? { border: 'border-red-200', bg: 'bg-red-50/60', badge: 'bg-red-100 text-red-700', label: '🔴 High' }
                        : f.urgency === 'low'
                          ? { border: 'border-slate-200', bg: 'bg-slate-50/40', badge: 'bg-slate-100 text-slate-500', label: '⚪ Low' }
                          : { border: 'border-rose-100', bg: 'bg-rose-50/40', badge: 'bg-amber-100 text-amber-700', label: '🟡 Medium' };
                      return (
                        <li
                          className={`border ${urgencyStyle.border} ${urgencyStyle.bg} rounded-lg p-3`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <p className="text-sm font-medium text-slate-900 flex-1">{f.title}</p>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {f.urgency && (
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${urgencyStyle.badge}`}>
                                  {urgencyStyle.label}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  verifyFollowUpMutation.mutate({
                                    index: i,
                                    followUp: f,
                                    analysisGeneratedAt: result.generatedAt,
                                  })
                                }
                                disabled={verifyingIndex === i}
                                className="text-[10px] text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300 rounded px-1.5 py-0.5 transition disabled:opacity-50 disabled:cursor-wait"
                                title="Verify this thread is resolved before clearing — uses Sonnet 4.6 to check the latest replies."
                              >
                                {verifyingIndex === i ? 'Checking…' : 'Clear'}
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-slate-600">{f.why}</p>
                          {hasSingleId ? (
                            <a
                              href={gmailMessageUrl(linkIds[0]!)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-rose-700 mt-1.5 font-medium hover:text-rose-900 hover:underline"
                            >
                              → {f.suggestedAction}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : (
                            <p className="text-xs text-rose-700 mt-1.5 font-medium">
                              → {f.suggestedAction}
                            </p>
                          )}
                          {!hasSingleId && (
                            <MessageLinks ids={linkIds} label="Reply in Gmail" />
                          )}
                          {verifyVerdicts[i] && (
                            <div className="mt-2 px-2 py-1.5 rounded border border-amber-200 bg-amber-50 text-[11px] text-amber-900 leading-snug">
                              <div className="font-medium">
                                {verifyVerdicts[i]!.verdict === 'unresolved'
                                  ? "Couldn't auto-clear: still unresolved"
                                  : 'Verification inconclusive'}
                              </div>
                              <div className="text-amber-800">
                                {verifyVerdicts[i]!.reason}
                              </div>
                              <div className="text-[10px] text-amber-700/80 mt-0.5">
                                Verified just now · {verifyVerdicts[i]!.model}
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    }}
                  </AccountGroupedList>
                  {dismissedFollowUps.size > 0 && (
                    <p className="text-[10px] text-slate-400 mt-2 text-right">
                      {dismissedFollowUps.size} cleared · will reappear on next scan if unresolved
                    </p>
                  )}
                  </>
                )}
              </section>

              {/* Invoices & Bills */}
              <section className="bg-white rounded-xl border border-slate-200 p-5">
                <SectionHeader
                  icon={Receipt}
                  title="Invoices & Bills"
                  count={result.invoices.length}
                  iconClass="bg-amber-100 text-amber-700"
                />
                {result.invoices.length === 0 ? (
                  <EmptyState message="No invoices in this window." />
                ) : (
                  <>
                  <AccountGroupedList
                    items={result.invoices}
                    getAccount={(inv) => inv.sourceAccount}
                    listClassName="space-y-2"
                  >
                    {(inv, i) => {
                      if (dismissedInvoices.has(i)) return null;
                      return (
                      <li
                        className="flex items-start justify-between gap-3 py-2 border-b last:border-0 border-slate-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900">{inv.vendor}</p>
                          <p className="text-xs text-slate-600 mt-0.5">{inv.summary}</p>
                          {inv.dueDate && (
                            <p className="text-[11px] text-amber-700 mt-1">Due: {inv.dueDate}</p>
                          )}
                          <MessageLinks
                            ids={
                              inv.sourceThreadId
                                ? [inv.sourceThreadId]
                                : inv.sourceMessageId
                                ? [inv.sourceMessageId]
                                : undefined
                            }
                            label="Open invoice"
                          />
                          {inv.attachments && inv.attachments.length > 0 && (
                            <AttachmentRow
                              messageId={inv.sourceMessageId}
                              attachments={inv.attachments}
                            />
                          )}
                          {verifyInvoiceVerdicts[i] && (
                            <div className="mt-2 px-2 py-1.5 rounded border border-amber-300 bg-amber-100 text-[11px] text-amber-900 leading-snug">
                              <div className="font-medium">
                                {verifyInvoiceVerdicts[i]!.verdict === 'unresolved'
                                  ? "Couldn't auto-clear: invoice still appears unpaid"
                                  : 'Verification inconclusive'}
                              </div>
                              <div className="text-amber-800">
                                {verifyInvoiceVerdicts[i]!.reason}
                              </div>
                              <div className="text-[10px] text-amber-700/80 mt-0.5">
                                Verified just now · {verifyInvoiceVerdicts[i]!.model}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                          {inv.amount != null && (
                            <span className="text-sm font-semibold text-slate-900 whitespace-nowrap">
                              ${inv.amount.toFixed(2)}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              verifyInvoiceMutation.mutate({
                                index: i,
                                invoice: inv,
                                analysisGeneratedAt: result.generatedAt,
                              })
                            }
                            disabled={verifyingInvoiceIndex === i}
                            className="text-[10px] text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300 rounded px-1.5 py-0.5 transition disabled:opacity-50 disabled:cursor-wait"
                            title="Verify payment / closure before clearing — uses Sonnet 4.6 to read the latest replies."
                          >
                            {verifyingInvoiceIndex === i ? 'Checking…' : 'Clear'}
                          </button>
                        </div>
                      </li>
                      );
                    }}
                  </AccountGroupedList>
                  {dismissedInvoices.size > 0 && (
                    <p className="text-[10px] text-slate-400 mt-2 text-right">
                      {dismissedInvoices.size} cleared · will reappear on next scan if unpaid
                    </p>
                  )}
                  </>
                )}
              </section>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Events */}
              <section className="bg-white rounded-xl border border-slate-200 p-5">
                <SectionHeader
                  icon={Calendar}
                  title="Events & Invitations"
                  count={result.events.length}
                  iconClass="bg-blue-100 text-blue-700"
                />
                {result.events.length === 0 ? (
                  <EmptyState message="No events or invitations in this window." />
                ) : (
                  <ul className="space-y-3">
                    {result.events.map((e, i) => (
                      <li key={i} className="border-l-2 border-blue-200 pl-3">
                        <p className="text-sm font-medium text-slate-900">{e.title}</p>
                        <p className="text-xs text-slate-600 mt-0.5">{e.summary}</p>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 mt-1.5">
                          {e.date && <span>📅 {e.date}</span>}
                          {e.location && <span>📍 {e.location}</span>}
                          {e.contactName && <span>👤 {e.contactName}</span>}
                          {e.contactEmail && <span>✉ {e.contactEmail}</span>}
                        </div>
                        <MessageLinks ids={e.sourceThreadIds ?? e.sourceMessageIds} label="Open invite" />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Vendors */}
              <section className="bg-white rounded-xl border border-slate-200 p-5">
                <SectionHeader
                  icon={Package}
                  title="Vendors"
                  count={result.vendors.length}
                  iconClass="bg-emerald-100 text-emerald-700"
                />
                {result.vendors.length === 0 ? (
                  <EmptyState message="No vendor activity in this window." />
                ) : (
                  <ul className="space-y-3">
                    {result.vendors.map((v, i) => (
                      <li key={i} className="border-l-2 border-emerald-200 pl-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900">{v.name}</p>
                          <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                            {v.messageCount} msg{v.messageCount === 1 ? '' : 's'}
                          </span>
                        </div>
                        {v.topics.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {v.topics.map((t, j) => (
                              <span
                                key={j}
                                className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        {v.actionItems && v.actionItems.length > 0 && (
                          <ul className="mt-2 space-y-0.5">
                            {v.actionItems.map((a, j) => (
                              <li key={j} className="text-[11px] text-slate-600">
                                → {a}
                              </li>
                            ))}
                          </ul>
                        )}
                        <MessageLinks ids={v.sourceThreadIds ?? v.sourceMessageIds} label="Open thread" />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Invoices section moved to row 2 (alongside Follow-ups). */}

              {/* Customer inquiries */}
              <section className="bg-white rounded-xl border border-slate-200 p-5">
                <SectionHeader
                  icon={MessageSquare}
                  title="Customer Inquiries"
                  count={result.customerInquiries.length}
                  iconClass="bg-purple-100 text-purple-700"
                />
                {result.customerInquiries.length === 0 ? (
                  <EmptyState message="No customer inquiries in this window." />
                ) : (
                  <ul className="space-y-3">
                    {result.customerInquiries.map((c, i) => {
                      const dateLabel = (() => {
                        if (!c.date) return null;
                        try {
                          return new Date(c.date).toLocaleDateString('en-US', {
                            timeZone: 'America/Chicago',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          });
                        } catch {
                          return c.date;
                        }
                      })();
                      const link = c.sourceThreadId ?? c.sourceMessageId;
                      const subject = (
                        <span className="text-sm font-medium text-slate-900 truncate inline-flex items-center gap-1">
                          {c.subject}
                          {link && (
                            <ExternalLink className="w-3 h-3 opacity-60" />
                          )}
                        </span>
                      );
                      return (
                        <li key={i} className="border-l-2 border-purple-200 pl-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            {link ? (
                              <a
                                href={gmailMessageUrl(link)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-purple-700 hover:underline truncate min-w-0"
                                title="Open in Gmail"
                              >
                                {subject}
                              </a>
                            ) : (
                              subject
                            )}
                            <span
                              className={`text-[9px] px-1.5 py-0.5 rounded-full border ${priorityClass(
                                c.priority
                              )}`}
                            >
                              {c.priority}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            From: {c.from}
                            {dateLabel && (
                              <>
                                {' · '}
                                <span className="text-slate-400">{dateLabel}</span>
                              </>
                            )}
                          </p>
                          <p className="text-xs text-slate-600 mt-1">{c.summary}</p>
                          {/* Always-visible Open-in-Gmail chip — mirrors how
                              vendors / events / follow-ups expose their link
                              affordance, so the link is impossible to miss
                              even when the subject is truncated. */}
                          {link && (
                            <MessageLinks ids={[link]} label="Open in Gmail" />
                          )}
                          {/* Attachment chips — shown when the email had attachments */}
                          {c.attachments && c.attachments.length > 0 && (
                            <AttachmentRow
                              messageId={c.sourceMessageId}
                              attachments={c.attachments}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            {/* Follow-ups (moved to top of page, just under Overview) */}

            {/* Top senders */}
            <section className="bg-white rounded-xl border border-slate-200 p-5">
              <SectionHeader
                icon={Mail}
                title="Top Senders"
                count={result.topSenders.length}
                iconClass="bg-slate-100 text-slate-700"
              />
              {result.topSenders.length === 0 ? (
                <EmptyState message="No senders to summarize." />
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                  {result.topSenders.map((s, i) => {
                    // Tavily-style: search the inbox for this sender, makes
                    // it one click to see every email from them.
                    const searchQuery = `from:${(s.from.match(/<([^>]+)>/) ?? [, s.from])[1]}`;
                    return (
                      <li
                        key={i}
                        className="flex items-center justify-between text-xs py-1 border-b last:border-0 border-slate-100"
                      >
                        <a
                          href={gmailSearchUrl(searchQuery)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-slate-700 hover:text-rose-700 hover:underline truncate flex items-center gap-1"
                          title={`Open all messages from this sender in Gmail`}
                        >
                          <span className="truncate">{s.from}</span>
                          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 opacity-60" />
                        </a>
                        <span className="text-slate-500 font-medium ml-2">{s.count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
          );
        })()}
      </main>

      {/* ── FS Assistant has replaced the page-scoped Gmail chat. Bubble
            mounts globally via <ProtectedShell />. Component file
            retained for rollback per Task 18.2 / Req 10.2. ── */}
    </div>
  );
}
