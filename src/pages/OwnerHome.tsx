/**
 * OwnerHome — curated single-page landing for non-admin (owner) users.
 *
 * Renders the following hand-picked sections from the full app, each
 * pulled from the same data sources the owner sees on the dedicated
 * pages so the numbers match exactly:
 *   1. Overview               ← /gmail/analyze (the prose summary)
 *   2. Vendor Directory       ← popout button into <SalesRevenue> Vendors tab
 *   3. Follow-ups Needed      ← /gmail/analyze
 *   4. Invoices & Bills       ← /gmail/analyze
 *   5. Events & Invitations   ← /gmail/analyze
 *   6. Open / Pending Orders  ← /pos/purchasing (same table as Sales tab)
 *
 * Heavy details (full vendor cards, full sales tabs, etc.) live behind
 * either the popout modal or `/sales` / `/gmail` direct nav. The
 * floating `<FsAssistant />` bubble (mounted in App.tsx) covers ad-hoc
 * questions about anything else.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  TrendingUp,
  ListTodo,
  Receipt,
  CalendarDays,
  ShoppingBag,
  Package,
  ExternalLink,
  LogOut,
  Loader2,
  AlertCircle,
  ChevronDown,
  X,
  KeyRound,
} from 'lucide-react';
import api from '../lib/api';
import { useAuth } from '../lib/auth';
import CentralTimeBadge from '../components/CentralTimeBadge';
import OrderRow from '../components/OrderRow';
import SalesRevenue from './SalesRevenue';
import FollowUpItem, { type FollowUp } from '../components/FollowUpItem';
import InvoiceItem, { type Invoice } from '../components/InvoiceItem';
import AccountGroupedList from '../components/AccountGroupedList';
import { gmailMessageUrl } from '../lib/gmailLinks';

// ── Types ────────────────────────────────────────────────────────────

interface PurchasingResponse {
  vendors: Array<{ id: number; name?: string; active?: boolean }>;
  vendorCount: number;
  vendorRank: Array<{
    vendorId: number;
    vendorName: string;
    totalReceivedQty: number;
    openOrders?: number;
    totalOrders?: number;
    rank: number;
  }>;
  orders: Array<{
    id: number;
    public_id?: string;
    status?: string;
    vendorName?: string;
    total_qty?: number;
    total_open_qty?: number;
    total_cost?: number;
    created_at?: string;
  }>;
  totalOrders: number;
  openOrderCount: number;
  cachedAt: string | null;
  notReady?: boolean;
  message?: string;
}

interface GmailEvent {
  title: string;
  date: string;
  time?: string;
  location?: string;
  contactName?: string | null;
  summary: string;
  sourceMessageIds: string[];
}
interface GmailInvoice {
  vendor: string;
  amount: number | null;
  dueDate: string | null;
  summary: string;
  sourceMessageId: string;
  sourceThreadId?: string;
}
interface GmailFollowUp {
  title: string;
  why: string;
  suggestedAction: string;
  urgency?: 'high' | 'medium' | 'low';
  sourceMessageIds: string[];
}
interface AnalysisResponse {
  overview?: string;
  events?: GmailEvent[];
  invoices?: GmailInvoice[];
  followUpsNeeded?: GmailFollowUp[];
  totalMessagesScanned?: number;
  generatedAt?: string;
  status?: 'ready' | 'running' | 'error' | 'none';
  /** Server-persisted IDs cleared via verify-on-clear. */
  dismissedFollowUpIds?: string[];
  dismissedInvoiceIds?: string[];
}

// ── Formatters ───────────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ── Reusable section header ──────────────────────────────────────────

function CardHeader({
  icon: Icon,
  title,
  count,
  iconClass,
  linkTo,
  linkLabel,
  rightSlot,
}: {
  icon: typeof TrendingUp;
  title: string;
  count?: number;
  iconClass: string;
  linkTo?: string;
  linkLabel?: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${iconClass}`}>
          <Icon className="w-4 h-4" />
        </div>
        <h2 className="text-base font-semibold text-slate-900 truncate">{title}</h2>
        {typeof count === 'number' && (
          <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex-shrink-0">
            {count}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {rightSlot}
        {linkTo && (
          <Link
            to={linkTo}
            className="text-[11px] text-slate-500 hover:text-slate-800 inline-flex items-center gap-1"
          >
            {linkLabel ?? 'Open'}
            <ExternalLink className="w-3 h-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

function CardEmpty({ message }: { message: string }) {
  return (
    <div className="text-sm text-slate-500 italic px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
      {message}
    </div>
  );
}

// ── Vendor Directory popout modal ────────────────────────────────────

function VendorDirectoryModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vendor-modal-title"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      tabIndex={-1}
    >
      <div
        className="bg-slate-50 sm:rounded-xl shadow-2xl w-full max-w-7xl flex flex-col overflow-hidden"
        style={{ height: 'min(95vh, 100vh)' }}
      >
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-white">
          <h3 id="vendor-modal-title" className="text-base font-semibold text-slate-900">
            Vendor Directory
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5"
            aria-label="Close vendor directory"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto bg-slate-50">
          {/* The same component the admin sees, forced onto the Vendors
              tab. SalesRevenue renders its own header and tabs; we hide
              its outer chrome via the modal layout. */}
          <SalesRevenue initialTab="vendors" embedded />
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function OwnerHome() {
  const { user, signOut } = useAuth();
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [dismissedFollowUps, setDismissedFollowUps] = useState<Set<number>>(new Set());
  const [dismissedInvoices, setDismissedInvoices] = useState<Set<number>>(new Set());

  const purchasingQ = useQuery<PurchasingResponse>({
    queryKey: ['pos', 'purchasing', 'owner'],
    queryFn: () => api.get<PurchasingResponse>('/pos/purchasing').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const gmailQ = useQuery<AnalysisResponse>({
    queryKey: ['gmail', 'analyze', 'owner'],
    queryFn: async () => {
      try {
        return (await api.get<AnalysisResponse>('/gmail/analyze')).data;
      } catch (err: unknown) {
        // 404 = no analysis cached yet — return empty shape so the UI still renders.
        const e = err as { response?: { status?: number } };
        if (e?.response?.status === 404) return { status: 'none' };
        throw err;
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  // Reset dismissed sets on a new analysis, then hydrate from the
  // server-persisted IDs so a refresh doesn't unhide cleared items.
  useEffect(() => {
    setDismissedFollowUps(new Set());
    setDismissedInvoices(new Set());
  }, [gmailQ.data?.generatedAt]);

  useEffect(() => {
    const data = gmailQ.data;
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
  }, [gmailQ.data]);

  const handleSignOut = () => {
    void signOut();
  };

  return (
    <div className="min-h-screen">
      <header className="app-header px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Foot Solutions
              <span className="text-slate-400 font-normal ml-1.5">— Flower Mound</span>
            </h1>
            {user && <p className="text-xs text-slate-500 mt-0.5">{user.email}</p>}
          </div>

          {/* Centered Credentials Vault button — quick access to the
              shared password / API key vault for non-admin owners. */}
          <div className="flex-shrink-0">
            <Link
              to="/credentials"
              className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:border-amber-400 transition-colors font-medium"
              title="Open the shared credentials vault"
            >
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              Credentials Vault
            </Link>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 flex-1 justify-end">
            <CentralTimeBadge />
            <button
              onClick={handleSignOut}
              className="btn-ghost"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* ── 1. Overview (Gmail Analysis narrative) ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-5">
          <CardHeader
            icon={TrendingUp}
            title="Overview"
            count={gmailQ.data?.totalMessagesScanned}
            iconClass="bg-rose-100 text-rose-700"
            linkTo="/gmail"
            linkLabel="Full report"
          />
          {gmailQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Generating inbox overview…
            </div>
          ) : gmailQ.isError ? (
            <div className="flex items-start gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              Couldn't load the inbox overview. Try the full report.
            </div>
          ) : !gmailQ.data?.overview ? (
            <CardEmpty message="No overview available yet — run an inbox analysis from the Gmail Assistant page." />
          ) : (
            <p className="text-sm text-slate-700 leading-relaxed">
              {gmailQ.data.overview}
            </p>
          )}
        </section>

        {/* ── 2. Vendor Directory — dropdown trigger only ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-5">
          <CardHeader
            icon={ShoppingBag}
            title="Vendor Directory"
            count={purchasingQ.data?.vendorCount}
            iconClass="bg-blue-100 text-blue-700"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-600 flex-1">
              {purchasingQ.isLoading
                ? 'Loading vendors…'
                : purchasingQ.data
                  ? `${(purchasingQ.data.vendorCount - 1).toLocaleString()} vendors with full contact info, account numbers, comments, and reps.`
                  : 'Click to view the full directory once it loads.'}
            </p>
            <button
              type="button"
              onClick={() => setVendorModalOpen(true)}
              disabled={purchasingQ.isLoading || !purchasingQ.data}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 hover:border-blue-400 transition disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              View vendor directory
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
        </section>

        {/* ── 3 & 4. Follow-ups + Invoices side-by-side ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Follow-ups Needed */}
          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <CardHeader
              icon={ListTodo}
              title="Follow-ups Needed"
              count={gmailQ.data?.followUpsNeeded?.length ?? 0}
              iconClass="bg-rose-100 text-rose-700"
              linkTo="/gmail"
              linkLabel="View all"
            />
            {gmailQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading inbox analysis…
              </div>
            ) : !gmailQ.data || (gmailQ.data.followUpsNeeded ?? []).length === 0 ? (
              <CardEmpty message="Inbox is clear — no obvious follow-ups." />
            ) : (
              <AccountGroupedList
                items={[...(gmailQ.data.followUpsNeeded ?? [])]
                  .sort((a, b) => {
                    const order = { high: 0, medium: 1, low: 2, undefined: 1 };
                    return (
                      (order[a.urgency ?? 'undefined'] ?? 1) -
                      (order[b.urgency ?? 'undefined'] ?? 1)
                    );
                  })
                  .slice(0, 6)}
                getAccount={(f) => f.sourceAccount}
              >
                {(f, i) => {
                  if (dismissedFollowUps.has(i)) return null;
                  return (
                    <FollowUpItem
                      followUp={f as FollowUp}
                      index={i}
                      analysisGeneratedAt={gmailQ.data?.generatedAt}
                      onResolved={(idx) =>
                        setDismissedFollowUps((prev) => new Set([...prev, idx]))
                      }
                    />
                  );
                }}
              </AccountGroupedList>
            )}
          </section>

          {/* Invoices & Bills */}
          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <CardHeader
              icon={Receipt}
              title="Invoices & Bills"
              count={gmailQ.data?.invoices?.length ?? 0}
              iconClass="bg-amber-100 text-amber-700"
              linkTo="/gmail"
              linkLabel="View all"
            />
            {gmailQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : !gmailQ.data || (gmailQ.data.invoices ?? []).length === 0 ? (
              <CardEmpty message="No outstanding invoices found in the inbox." />
            ) : (
              <AccountGroupedList
                items={(gmailQ.data.invoices ?? []).slice(0, 6)}
                getAccount={(inv) => inv.sourceAccount}
              >
                {(inv, i) => {
                  if (dismissedInvoices.has(i)) return null;
                  return (
                    <InvoiceItem
                      invoice={inv as Invoice}
                      index={i}
                      analysisGeneratedAt={gmailQ.data?.generatedAt}
                      onResolved={(idx) =>
                        setDismissedInvoices((prev) => new Set([...prev, idx]))
                      }
                      compact
                    />
                  );
                }}
              </AccountGroupedList>
            )}
          </section>
        </div>

        {/* ── 5. Events & Invitations ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-5">
          <CardHeader
            icon={CalendarDays}
            title="Events & Invitations"
            count={gmailQ.data?.events?.length ?? 0}
            iconClass="bg-indigo-100 text-indigo-700"
            linkTo="/gmail"
            linkLabel="View all"
          />
          {gmailQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !gmailQ.data || (gmailQ.data.events ?? []).length === 0 ? (
            <CardEmpty message="No upcoming events flagged in the inbox." />
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(gmailQ.data.events ?? []).slice(0, 6).map((ev, i) => {
                const linkId = ev.sourceMessageIds?.[0];
                return (
                  <li
                    key={i}
                    className="border border-indigo-100 bg-indigo-50/40 rounded-lg p-3"
                  >
                    <p className="text-sm font-medium text-slate-900">{ev.title}</p>
                    <p className="text-xs text-indigo-700 mt-0.5">
                      {ev.date}
                      {ev.time ? ` · ${ev.time}` : ''}
                      {ev.location ? ` · ${ev.location}` : ''}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">{ev.summary}</p>
                    {linkId && (
                      <a
                        href={gmailMessageUrl(linkId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-indigo-700 hover:underline inline-flex items-center gap-1 mt-1"
                      >
                        Open in Gmail
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── 6. Open / Pending Orders — full table, same as owner screen ── */}
        <section className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {purchasingQ.isLoading ? (
            <div className="px-5 py-6 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading orders…
            </div>
          ) : purchasingQ.isError ? (
            <div className="px-5 py-4 flex items-start gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              Couldn't load orders. Try refreshing.
            </div>
          ) : purchasingQ.data?.notReady ? (
            <div className="px-5 py-4 text-sm text-amber-800 bg-amber-50 border-b border-amber-200">
              {purchasingQ.data.message ?? 'Purchasing data not ready yet.'}
            </div>
          ) : purchasingQ.data && purchasingQ.data.orders.length > 0 ? (
            <>
              <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-100 text-violet-700">
                    <Package className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Open / Pending Orders
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Last synced {relativeTime(purchasingQ.data.cachedAt)} · click any row to view line items
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-md px-2.5 py-1 shrink-0">
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span className="text-xs font-semibold">
                    {purchasingQ.data.openOrderCount.toLocaleString()}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-amber-700">
                    open
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-4 py-2 text-slate-500 font-medium w-8"></th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">PO #</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Vendor</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Status</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Created</th>
                      <th className="text-right px-4 py-2 text-slate-500 font-medium">Days Open</th>
                      <th className="text-right px-4 py-2 text-slate-500 font-medium">Qty Ordered</th>
                      <th className="text-right px-4 py-2 text-slate-500 font-medium">Qty Open</th>
                      <th className="text-right px-4 py-2 text-slate-500 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {[...purchasingQ.data.orders]
                      .sort((a, b) => {
                        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
                        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
                        return bt - at;
                      })
                      .slice(0, 50)
                      .map((o) => (
                        <OrderRow key={o.id} order={o} />
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="px-5 py-6">
              <CardEmpty message="No orders right now." />
            </div>
          )}
        </section>
      </main>

      <VendorDirectoryModal
        open={vendorModalOpen}
        onClose={() => setVendorModalOpen(false)}
      />
    </div>
  );
}
