/**
 * CampaignCard — admin-only Campaign tooling on OwnerHome.
 *
 * Three sub-views inside the same card:
 *   • Stats panel — total customers, with email, opted in, reachable, last sync
 *   • Customer table — search/filter + multi-select rows
 *   • Composer — subject, HTML body (with paste-image support), test-email,
 *                send mode (selected / all / wave)
 *
 * Backed by:
 *   GET  /pos/customers?q=&hasEmail=&optedIn=&reachable=&limit=&cursor=
 *   POST /pos/customers/sync     — refresh from Heartland (~30-60s)
 *   POST /campaign/send          — test / selected / all (with wave-cursor)
 *
 * Hidden for non-admin users — the parent OwnerHome only mounts it
 * when isAdmin is true.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail,
  RefreshCw,
  Search,
  Send,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  X,
  Users,
  ChevronDown,
  Clock,
  History,
  Eye,
} from 'lucide-react';
import api from '../lib/api';
import { useAdmin } from '../lib/admin';
import { CAMPAIGN_TEMPLATES } from '../lib/campaignTemplates';
import {
  compressImageToTarget,
  formatBytes,
} from '../lib/imageCompression';
import CustomerHistoryPanel from './CustomerHistoryPanel';
import EmailPreviewModal from './EmailPreviewModal';

type CustomerFilter =
  | 'all'
  | 'withEmail'
  | 'reachable'
  | 'optedIn'
  | 'dormant6m'
  | 'dormant12m';

interface CustomerRow {
  customerId: number;
  publicId?: string | null;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phoneNumber?: string | null;
  active?: boolean;
  promotionalEmails?: boolean;
  promotionalMessages?: boolean;
  loyaltyBalance?: number;
  loyaltyTotal?: number;
  createdAt?: string | null;
  unsubscribed?: boolean;
  lastPurchaseAt?: string | null;
}

interface CustomerStats {
  totalCustomers: number;
  totalReported: number;
  withEmail: number;
  optedIn: number;
  reachableEmails: number;
  activeCount: number;
  dormant6m?: number;
  dormant12m?: number;
  signupsByMonth: Array<{ month: string; count: number }>;
  updatedAt: string | null;
  recencyUpdatedAt?: string | null;
}

interface CustomersResponse {
  customers: CustomerRow[];
  stats: CustomerStats | null;
  cursor: string | null;
  hasMore: boolean;
}

interface SendResponse {
  sent: number;
  failed: number;
  errors: string[];
  totalRecipients: number;
  durationMs: number;
  testMode: boolean;
  optInMode: 'strict' | 'permissive';
  nextWaveCursor: number | null;
  hasMoreWaves: boolean;
}

type AudienceMode = 'selected' | 'all';
type OptInMode = 'strict' | 'permissive';

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function lastVisitDisplay(iso: string | null | undefined): {
  text: string;
  className: string;
} {
  if (!iso) return { text: '—', className: 'text-slate-300 italic' };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { text: '—', className: 'text-slate-300 italic' };
  const months = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
  let className = 'text-slate-600';
  if (months >= 12) className = 'text-rose-700 font-medium';
  else if (months >= 6) className = 'text-amber-700';
  return {
    text: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    className,
  };
}

function StatTile({
  label,
  value,
  sub,
  highlight = false,
  tone,
  onClick,
  active = false,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  tone?: 'default' | 'warning' | 'danger';
  onClick?: () => void;
  active?: boolean;
}) {
  const toneClasses =
    tone === 'danger'
      ? active
        ? 'border-rose-300 bg-rose-100 ring-2 ring-rose-300'
        : 'border-rose-200 bg-rose-50 hover:bg-rose-100'
      : tone === 'warning'
        ? active
          ? 'border-amber-300 bg-amber-100 ring-2 ring-amber-300'
          : 'border-amber-200 bg-amber-50 hover:bg-amber-100'
        : highlight
          ? 'border-emerald-200 bg-emerald-50'
          : active
            ? 'border-indigo-300 bg-indigo-50 ring-2 ring-indigo-300'
            : 'border-slate-200 bg-slate-50 hover:bg-slate-100';

  const valueTone =
    tone === 'danger'
      ? 'text-rose-900'
      : tone === 'warning'
        ? 'text-amber-900'
        : highlight
          ? 'text-emerald-900'
          : 'text-slate-900';

  const labelTone =
    tone === 'danger' ? 'text-rose-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-500';

  const subTone =
    tone === 'danger' ? 'text-rose-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-500';

  const Component = onClick ? 'button' : 'div';
  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left rounded-lg border p-3 transition ${toneClasses} ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      <p className={`text-[10px] uppercase tracking-wide font-medium ${labelTone}`}>{label}</p>
      <p className={`text-xl font-bold mt-1 tabular-nums ${valueTone}`}>{value}</p>
      {sub && <p className={`text-[10px] mt-0.5 ${subTone}`}>{sub}</p>}
    </Component>
  );
}

export default function CampaignCard() {
  const { isAdmin } = useAdmin();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CustomerFilter>('reachable');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('selected');
  const [optInMode, setOptInMode] = useState<OptInMode>('strict');
  const [waveSize, setWaveSize] = useState<number>(500);
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [lastResult, setLastResult] = useState<SendResponse | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [waveCursor, setWaveCursor] = useState<number | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageNotice, setImageNotice] = useState<{
    kind: 'compressed' | 'failed' | 'invalid';
    message: string;
  } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);

  // Customer list query.
  const customersQ = useQuery<CustomersResponse>({
    queryKey: ['campaign', 'customers', search, filter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (filter === 'withEmail') params.set('hasEmail', 'true');
      if (filter === 'reachable') params.set('reachable', 'true');
      if (filter === 'optedIn') params.set('optedIn', 'true');
      if (filter === 'dormant6m') {
        params.set('hasEmail', 'true');
        params.set('dormancy', '6m');
      }
      if (filter === 'dormant12m') {
        params.set('hasEmail', 'true');
        params.set('dormancy', '12m');
      }
      params.set('limit', '200');
      return api.get<CustomersResponse>(`/pos/customers?${params}`).then((r) => r.data);
    },
    enabled: isAdmin,
    staleTime: 60 * 1000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post<{ status: string }>('/pos/customers/sync', {}).then((r) => r.data),
    onSuccess: () => {
      // Stats won't update for ~30-60s — invalidate after a delay.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['campaign', 'customers'] });
      }, 45_000);
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (payload: {
      subject: string;
      htmlBody: string;
      recipients?: AudienceMode;
      selectedIds?: number[];
      testEmail?: string;
      optInMode?: OptInMode;
      waveSize?: number;
      waveCursor?: number;
    }) => {
      const res = await api.post<SendResponse>('/campaign/send', payload);
      return res.data;
    },
    onSuccess: (data) => {
      setLastResult(data);
      if (data.hasMoreWaves) setWaveCursor(data.nextWaveCursor);
      else setWaveCursor(null);
    },
  });

  const stats = customersQ.data?.stats;
  const customers = customersQ.data?.customers ?? [];

  const selectableCustomers = useMemo(
    () => customers.filter((c) => c.email && !c.unsubscribed),
    [customers]
  );

  const allSelectableSelected =
    selectableCustomers.length > 0 &&
    selectableCustomers.every((c) => selectedIds.has(c.customerId));

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (allSelectableSelected) {
        const next = new Set(prev);
        for (const c of selectableCustomers) next.delete(c.customerId);
        return next;
      }
      const next = new Set(prev);
      for (const c of selectableCustomers) next.add(c.customerId);
      return next;
    });
  }, [allSelectableSelected, selectableCustomers]);

  // Paste-image / file-upload → inline base64 data URL.
  // Auto-compresses anything over 2MB so the email stays under SES /
  // mailbox-provider size limits. The user gets a small banner showing
  // what happened (or a graceful failure message).
  const handleImageUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setImageNotice({
        kind: 'invalid',
        message: 'That file isn\'t an image.',
      });
      return;
    }

    setImageBusy(true);
    setImageNotice(null);
    try {
      const result = await compressImageToTarget(file);

      const imgTag = `<img src="${result.dataUrl}" alt="" style="max-width:100%;height:auto;border-radius:8px;margin:8px 0" />`;
      setHtmlBody((prev) => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + imgTag);

      if (result.compressed) {
        setImageNotice({
          kind: 'compressed',
          message: `Image compressed from ${formatBytes(result.originalBytes)} to ${formatBytes(result.bytes)} (auto-resized to fit email size limits).`,
        });
      } else if (result.bytes > 2 * 1024 * 1024) {
        // Original was over the cap and we couldn't compress (fallback path).
        setImageNotice({
          kind: 'failed',
          message: `Couldn't compress this image — it's still ${formatBytes(result.bytes)}. Email may be flagged as too large by some inbox providers.`,
        });
      }
    } catch (err) {
      setImageNotice({
        kind: 'failed',
        message: `Couldn't process image: ${(err as Error).message}`,
      });
    } finally {
      setImageBusy(false);
    }
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items ?? [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void handleImageUpload(file);
          }
        }
      }
    },
    [handleImageUpload]
  );

  if (!isAdmin) return null;

  // Compute the projected reach of the chosen audience config.
  const projectedReach = (() => {
    if (audienceMode === 'selected') return selectedIds.size;
    if (!stats) return 0;
    return optInMode === 'permissive' ? stats.reachableEmails : stats.optedIn;
  })();

  // Templates that match the current audience filter — highlighted in the
  // picker so the user picks something appropriate.
  const recommendedTemplateIds = useMemo<Set<string>>(() => {
    const ids = new Set<string>();
    if (filter === 'dormant6m') {
      ids.add('we-miss-you');
      ids.add('comeback-discount');
    } else if (filter === 'dormant12m') {
      ids.add('comeback-discount');
      ids.add('orthotics-reminder');
      ids.add('we-miss-you');
    } else if (filter === 'optedIn') {
      ids.add('thank-you-loyalty');
      ids.add('new-arrivals');
    }
    return ids;
  }, [filter]);

  const selectedTemplate = selectedTemplateId
    ? CAMPAIGN_TEMPLATES.find((t) => t.id === selectedTemplateId) ?? null
    : null;

  const applyTemplate = useCallback((id: string) => {
    const tpl = CAMPAIGN_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    setSelectedTemplateId(id);
    if (tpl.id !== 'blank') {
      setSubject(tpl.subject);
      setHtmlBody(tpl.bodyHtml);
    } else {
      setSubject('');
      setHtmlBody('');
    }
  }, []);

  const clearTemplate = useCallback(() => {
    setSelectedTemplateId(null);
  }, []);

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700">
            <Mail className="w-4 h-4" />
          </div>
          <h2 className="text-base font-semibold text-slate-900 truncate">Campaign</h2>
          {stats && (
            <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex-shrink-0">
              {stats.totalCustomers.toLocaleString()} customers
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition disabled:opacity-50"
            title="Pull a fresh customer list from Heartland — takes 30-60 seconds"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshMutation.isPending ? 'animate-spin' : ''}`}
            />
            {refreshMutation.isPending ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => setComposerOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition font-medium"
          >
            <Send className="w-3.5 h-3.5" />
            New campaign
          </button>
        </div>
      </div>

      {/* Stats grid */}
      {customersQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading customers…
        </div>
      ) : !stats ? (
        <div className="text-sm text-slate-500 italic px-3 py-2 bg-slate-50 rounded border border-slate-100">
          No customer data yet. Click <strong>Refresh</strong> to pull from Heartland.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
            <StatTile
              label="Total"
              value={stats.totalCustomers.toLocaleString()}
              sub={`${stats.activeCount.toLocaleString()} active`}
            />
            <StatTile
              label="With email"
              value={stats.withEmail.toLocaleString()}
              sub={`${Math.round((stats.withEmail / Math.max(stats.totalCustomers, 1)) * 100)}% of customers`}
              onClick={() => setFilter('withEmail')}
              active={filter === 'withEmail'}
            />
            <StatTile
              label="Opted in (strict)"
              value={stats.optedIn.toLocaleString()}
              sub="Heartland promo flag = true"
              highlight
              onClick={() => setFilter('optedIn')}
              active={filter === 'optedIn'}
            />
            <StatTile
              label="Reachable (permissive)"
              value={stats.reachableEmails.toLocaleString()}
              sub="email present, not unsubscribed"
              onClick={() => setFilter('reachable')}
              active={filter === 'reachable'}
            />
            <StatTile
              label="6m+ dormant"
              value={(stats.dormant6m ?? 0).toLocaleString()}
              sub="no purchase in 6+ months"
              tone="warning"
              onClick={() => setFilter('dormant6m')}
              active={filter === 'dormant6m'}
            />
            <StatTile
              label="12m+ dormant"
              value={(stats.dormant12m ?? 0).toLocaleString()}
              sub="no purchase in 12+ months"
              tone="danger"
              onClick={() => setFilter('dormant12m')}
              active={filter === 'dormant12m'}
            />
          </div>
          <p className="text-[11px] text-slate-400 mb-3">
            Last sync {relativeTime(stats.updatedAt)}
            {stats.recencyUpdatedAt && (
              <span className="ml-2 text-slate-500">
                · purchase history {relativeTime(stats.recencyUpdatedAt)}
              </span>
            )}
            {!stats.recencyUpdatedAt && (
              <span className="ml-2 text-amber-600">
                · purchase history not synced yet — click Refresh
              </span>
            )}
            {refreshMutation.isPending && (
              <span className="ml-2 text-indigo-600">· refreshing now (30-60s)…</span>
            )}
            {refreshMutation.isSuccess && !refreshMutation.isPending && (
              <span className="ml-2 text-emerald-600">· refresh queued, stats update in ~45s</span>
            )}
          </p>
        </>
      )}

      {/* Search + filter */}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or phone…"
            className="w-full text-sm pl-8 pr-8 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as CustomerFilter)}
          className="text-sm rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
        >
          <option value="all">All customers</option>
          <option value="withEmail">With email</option>
          <option value="reachable">Reachable (permissive)</option>
          <option value="optedIn">Opted in (strict)</option>
          <option value="dormant6m">Haven't purchased in 6+ months</option>
          <option value="dormant12m">Haven't purchased in 12+ months</option>
        </select>
      </div>

      {/* Selection summary */}
      {selectedIds.size > 0 && (
        <div className="mb-2 px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 flex items-center justify-between">
          <span>
            <strong>{selectedIds.size}</strong>{' '}
            {selectedIds.size === 1 ? 'recipient' : 'recipients'} selected
          </span>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-indigo-700 hover:underline"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Customer table */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left w-8">
                <input
                  type="checkbox"
                  checked={allSelectableSelected}
                  onChange={toggleSelectAll}
                  disabled={selectableCustomers.length === 0}
                  className="cursor-pointer"
                  title="Select all reachable on this page"
                />
              </th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Name</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Email</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Phone</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Last visit
                </span>
              </th>
              <th className="px-3 py-2 text-center font-medium text-slate-500">Status</th>
              <th className="px-3 py-2 text-center font-medium text-slate-500 w-12">
                <span className="sr-only">History</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-400 italic">
                  {customersQ.isLoading ? 'Loading…' : 'No customers match this filter.'}
                </td>
              </tr>
            ) : (
              customers.map((c) => {
                const reachable = !!c.email && !c.unsubscribed;
                const checked = selectedIds.has(c.customerId);
                const lastVisit = lastVisitDisplay(c.lastPurchaseAt);
                return (
                  <tr
                    key={c.customerId}
                    className={`border-t border-slate-100 ${
                      reachable ? 'hover:bg-indigo-50/30 cursor-pointer' : 'opacity-60'
                    }`}
                    onClick={() => reachable && toggleSelect(c.customerId)}
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(c.customerId)}
                        disabled={!reachable}
                        onClick={(e) => e.stopPropagation()}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-slate-800 font-medium truncate max-w-[180px]">
                      {c.name || '(no name)'}
                    </td>
                    <td className="px-3 py-1.5 text-slate-600 truncate max-w-[220px]">
                      {c.email || <span className="text-slate-300 italic">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-slate-600 truncate max-w-[120px]">
                      {c.phoneNumber || <span className="text-slate-300 italic">—</span>}
                    </td>
                    <td className={`px-3 py-1.5 whitespace-nowrap ${lastVisit.className}`}>
                      {lastVisit.text}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {c.unsubscribed ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                          unsubscribed
                        </span>
                      ) : c.promotionalEmails ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                          opted in
                        </span>
                      ) : c.email ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                          reachable
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                          no email
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistoryCustomer({
                            id: c.customerId,
                            name: c.name || '(no name)',
                          });
                        }}
                        title="View purchase history"
                        className="inline-flex items-center justify-center w-7 h-7 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {customersQ.data?.hasMore && (
        <p className="text-[11px] text-slate-400 mt-2 text-right">
          Showing first {customers.length}. Refine the search to narrow results.
        </p>
      )}

      {/* Composer drawer */}
      {composerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 backdrop-blur-sm overflow-y-auto p-4 sm:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) setComposerOpen(false);
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col my-auto"
            style={{ maxHeight: 'calc(100vh - 3rem)' }}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900">New Campaign</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  From <strong>notifications@fsmanagementsystem.com</strong> · Reply-to{' '}
                  <strong>flowermound@footsolutions.com</strong>
                </p>
              </div>
              <button
                onClick={() => setComposerOpen(false)}
                className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Templates picker */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-600">
                    Start from a template
                  </label>
                  {selectedTemplate && (
                    <button
                      type="button"
                      onClick={clearTemplate}
                      className="text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
                    >
                      Clear template
                    </button>
                  )}
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                  {CAMPAIGN_TEMPLATES.map((tpl) => {
                    const isActive = selectedTemplateId === tpl.id;
                    const isRecommended = recommendedTemplateIds.has(tpl.id);
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => applyTemplate(tpl.id)}
                        title={tpl.description}
                        className={`flex-shrink-0 w-[140px] text-left rounded-lg border p-2.5 transition ${
                          isActive
                            ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300'
                            : isRecommended
                              ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100'
                              : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg leading-none">{tpl.emoji}</span>
                          <span className="text-xs font-semibold text-slate-800 truncate">
                            {tpl.name}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1 line-clamp-2 leading-tight">
                          {tpl.description}
                        </p>
                        <p
                          className={`text-[9px] uppercase tracking-wide mt-1 font-medium ${
                            isRecommended ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {isRecommended ? '★ recommended' : tpl.bestFor}
                        </p>
                      </button>
                    );
                  })}
                </div>
                {selectedTemplate && selectedTemplate.id !== 'blank' && (
                  <div className="mt-1 px-2.5 py-1.5 rounded bg-indigo-50 border border-indigo-100 text-[11px] text-indigo-800 flex items-center gap-2">
                    <span className="text-base leading-none">{selectedTemplate.emoji}</span>
                    <span>
                      Using template: <strong>{selectedTemplate.name}</strong>
                      <span className="text-indigo-600/70 ml-1">— {selectedTemplate.bestFor}</span>
                    </span>
                  </div>
                )}
              </div>

              {/* Audience picker */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-600">Audience</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAudienceMode('selected')}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition ${
                      audienceMode === 'selected'
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-800 font-medium'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5 inline mr-1.5" />
                    Selected ({selectedIds.size})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudienceMode('all')}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition ${
                      audienceMode === 'all'
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-800 font-medium'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5 inline mr-1.5" />
                    All eligible ({projectedReach.toLocaleString()})
                  </button>
                </div>

                {/* Permissive override */}
                {audienceMode === 'all' && (
                  <label className="flex items-start gap-2 mt-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={optInMode === 'permissive'}
                      onChange={(e) =>
                        setOptInMode(e.target.checked ? 'permissive' : 'strict')
                      }
                      className="mt-0.5 cursor-pointer"
                    />
                    <div className="flex-1 text-xs">
                      <p className="font-medium text-amber-900">
                        Permissive mode — email all customers with email addresses
                      </p>
                      <p className="text-amber-800 mt-0.5">
                        Sends to anyone with an email who hasn't unsubscribed. Use this when
                        Heartland's "promotional emails" flag is defaulted to false en masse
                        but customers gave their email at the POS. Always honors actual
                        unsubscribes. Per CAN-SPAM, the unsubscribe link + store address (in
                        the footer) make this legal for established business relationships.
                      </p>
                    </div>
                  </label>
                )}

                {/* Wave-send picker — only when audience=all */}
                {audienceMode === 'all' && (
                  <div className="flex items-center gap-2 mt-2">
                    <label className="text-[11px] text-slate-600 flex items-center gap-1">
                      Send in waves of
                      <input
                        type="number"
                        min={50}
                        max={5000}
                        step={50}
                        value={waveSize}
                        onChange={(e) => setWaveSize(Number(e.target.value) || 500)}
                        className="w-20 text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      recipients
                    </label>
                    <p className="text-[10px] text-slate-400">
                      Sends one wave per click. Watch unsubscribe + complaint rate before continuing.
                    </p>
                  </div>
                )}
              </div>

              {/* Subject */}
              <div>
                <label className="text-xs font-medium text-slate-600">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Spring savings at Foot Solutions Flower Mound"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Body */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-600">
                    Email body (HTML — paste images directly)
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setPreviewOpen(true)}
                      disabled={!subject.trim() && !htmlBody.trim()}
                      title="See exactly what recipients will see — header, body, and footer"
                      className="text-[11px] text-indigo-600 hover:underline cursor-pointer flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                    >
                      <Eye className="w-3 h-3" />
                      Preview
                    </button>
                    <label
                      className={`text-[11px] flex items-center gap-1 ${
                        imageBusy
                          ? 'text-slate-400 cursor-wait'
                          : 'text-indigo-600 hover:underline cursor-pointer'
                      }`}
                    >
                      {imageBusy ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Compressing…
                        </>
                      ) : (
                        <>
                          <ImageIcon className="w-3 h-3" />
                          Upload image
                        </>
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        disabled={imageBusy}
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleImageUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
                <textarea
                  ref={bodyRef as unknown as React.RefObject<HTMLTextAreaElement>}
                  value={htmlBody}
                  onChange={(e) => setHtmlBody(e.target.value)}
                  onPaste={onPaste}
                  rows={10}
                  placeholder={'<p>Hi friends,</p>\n<p>We just got the new spring Hokas in — come check them out!</p>\n<p>Show this email at checkout for 10% off.</p>'}
                  className="w-full text-sm font-mono border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Header (Foot Solutions branding) and footer (address + unsubscribe link) get added automatically.
                </p>
                {imageNotice && (
                  <div
                    className={`mt-2 px-2.5 py-1.5 rounded-lg border text-[11px] flex items-start gap-1.5 ${
                      imageNotice.kind === 'compressed'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}
                  >
                    {imageNotice.kind === 'compressed' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    )}
                    <span className="flex-1">{imageNotice.message}</span>
                    <button
                      type="button"
                      onClick={() => setImageNotice(null)}
                      className="text-current opacity-60 hover:opacity-100 flex-shrink-0"
                      aria-label="Dismiss"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Test send */}
              <div className="border-t border-slate-100 pt-4">
                <label className="text-xs font-medium text-slate-600">
                  Send a test first (recommended)
                </label>
                <div className="flex gap-2 mt-1">
                  <input
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      sendMutation.mutate({
                        subject,
                        htmlBody,
                        testEmail: testEmail.trim(),
                      })
                    }
                    disabled={
                      !testEmail.trim() ||
                      !subject.trim() ||
                      !htmlBody.trim() ||
                      sendMutation.isPending
                    }
                    className="text-sm px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition disabled:opacity-50 whitespace-nowrap"
                  >
                    Send test
                  </button>
                </div>
              </div>

              {/* Last result */}
              {lastResult && (
                <div
                  className={`px-3 py-2.5 rounded-lg border ${
                    lastResult.failed > 0
                      ? 'border-amber-200 bg-amber-50'
                      : 'border-emerald-200 bg-emerald-50'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm">
                    {lastResult.failed > 0 ? (
                      <AlertCircle className="w-4 h-4 text-amber-700" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                    )}
                    <strong className={lastResult.failed > 0 ? 'text-amber-900' : 'text-emerald-900'}>
                      {lastResult.testMode ? 'Test sent' : 'Campaign sent'}
                    </strong>
                    <span className="text-xs text-slate-700">
                      · {lastResult.sent.toLocaleString()} delivered
                      {lastResult.failed > 0 && `, ${lastResult.failed} failed`}
                      {' · '}
                      {(lastResult.durationMs / 1000).toFixed(1)}s
                      {lastResult.optInMode && (
                        <span className="ml-1 text-[10px] uppercase tracking-wide bg-white border border-current rounded px-1 py-0.5">
                          {lastResult.optInMode}
                        </span>
                      )}
                    </span>
                  </div>
                  {lastResult.errors.length > 0 && (
                    <ul className="mt-1.5 text-[11px] text-amber-800 list-disc pl-5 space-y-0.5">
                      {lastResult.errors.slice(0, 3).map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                  {lastResult.hasMoreWaves && (
                    <p className="text-[11px] text-amber-800 mt-1.5 flex items-center gap-1">
                      <ChevronDown className="w-3 h-3" />
                      More waves remaining — click "Send next wave" below to continue.
                    </p>
                  )}
                </div>
              )}

              {sendMutation.isError && (
                <div className="px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{(sendMutation.error as Error).message}</span>
                </div>
              )}
            </div>

            {/* Footer with primary send button */}
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 bg-slate-50">
              <p className="text-[11px] text-slate-500 leading-tight">
                Reach: <strong>{projectedReach.toLocaleString()}</strong>{' '}
                {audienceMode === 'all' && optInMode === 'permissive' && (
                  <span className="text-amber-700">(permissive)</span>
                )}
                {audienceMode === 'all' && waveSize && (
                  <span className="text-slate-400"> · waves of {waveSize}</span>
                )}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setComposerOpen(false)}
                  className="text-sm px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  disabled={!subject.trim() && !htmlBody.trim()}
                  title="Preview the rendered email before sending"
                  className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Preview
                </button>
                <button
                  onClick={() => {
                    if (audienceMode === 'selected') {
                      sendMutation.mutate({
                        subject,
                        htmlBody,
                        recipients: 'selected',
                        selectedIds: [...selectedIds],
                        optInMode,
                      });
                    } else {
                      sendMutation.mutate({
                        subject,
                        htmlBody,
                        recipients: 'all',
                        optInMode,
                        waveSize,
                        waveCursor: waveCursor ?? 0,
                      });
                    }
                  }}
                  disabled={
                    !subject.trim() ||
                    !htmlBody.trim() ||
                    sendMutation.isPending ||
                    (audienceMode === 'selected' && selectedIds.size === 0)
                  }
                  className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {sendMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  {sendMutation.isPending
                    ? 'Sending…'
                    : lastResult?.hasMoreWaves
                      ? 'Send next wave'
                      : `Send to ${projectedReach.toLocaleString()}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Customer history panel */}
      {historyCustomer && (
        <CustomerHistoryPanel
          customerId={historyCustomer.id}
          customerName={historyCustomer.name}
          onClose={() => setHistoryCustomer(null)}
        />
      )}

      {/* Email preview modal */}
      {previewOpen && (
        <EmailPreviewModal
          subject={subject}
          bodyHtml={htmlBody}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </section>
  );
}
