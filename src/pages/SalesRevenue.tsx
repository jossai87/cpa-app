import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  TrendingUp,
  ShoppingBag,
  Users,
  CreditCard,
  Package,
  RefreshCw,
  Clock,
  Tag,
  CloudDownload,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import Spinner from '../components/Spinner';

// ── Types ─────────────────────────────────────────────────────────────

interface DashboardResponse {
  today: { totalAmount: number; ticketCount: number };
  last7Days: { totalAmount: number; ticketCount: number };
  last30Days: { totalAmount: number; ticketCount: number };
  yearToDate: { totalAmount: number; ticketCount: number };
  syncInfo?: { lastSyncAt: string | null; status: string };
  asOf: string;
}

interface SyncStatusResponse {
  lastSyncAt?: string | null;
  completedAt?: string | null;
  status?: string;
  trigger?: string;
  durationMs?: number;
  payments?: { daysWritten?: number; paymentsScanned?: number; ticketsScanned?: number; durationMs?: number; error?: string };
  inventory?: { totalItems?: number; activeItems?: number; liveItems?: number; durationMs?: number; error?: string };
  users?: { count?: number; durationMs?: number; error?: string };
  paymentTypes?: { count?: number; durationMs?: number; error?: string };
  message?: string;
}

interface AnalyticsResponse {
  days: number;
  fromDate: string;
  toDate: string;
  summary: { totalAmount: number; totalCount: number; avgTicket: number };
  dailyTrend: Array<{ date: string; amount: number; count: number }>;
  paymentMethods: Array<{ id: string; name: string; amount: number; count: number; pct: number }>;
  hourlyHeatmap: Array<{ hour: number; label: string; amount: number }>;
  topCustomers: Array<{ name: string; amount: number; visits: number }>;
  bySalesRep: Array<{ name: string; amount: number; count: number }>;
  discountSummary: { totalDiscounts: number; discountRate: number; avgDiscountPerTicket: number };
  asOf: string;
}

interface InventoryResponse {
  summary: { totalItems: number; activeItems: number; liveItems?: number; itemsWithCostData: number; overallAvgMarginPct: number };
  byDepartment: Array<{ name: string; count: number; avgMargin: number; totalCost: number; totalPrice: number }>;
  byBrand: Array<{ name: string; count: number; totalRevenue: number }>;
  topMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number; brand: string; department: string }>;
  lowMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number }>;
  cached: boolean;
  cachedAt: string | null;
  notReady?: boolean;
  message?: string;
}

interface StaffResponse {
  year: string;
  staff: Array<{ name: string; rawName: string; ytdAmount: number; activeDays: number; avgPerDay: number }>;
  totalUsers: number;
  asOf: string;
}

// ── Formatters ────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtDec(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function fmtPct(n: number): string { return `${n.toFixed(1)}%`; }
function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// ── Shared components ─────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color = 'blue' }: {
  label: string; value: string; sub?: string;
  icon: React.ElementType; color?: 'blue' | 'green' | 'purple' | 'amber';
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
          {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
        </div>
        <div className={`rounded-lg p-2 ${colors[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

// ── Sparkline chart (SVG, no library) ────────────────────────────────

function Sparkline({ data, width = 400, height = 80 }: {
  data: Array<{ date: string; amount: number }>;
  width?: number;
  height?: number;
}) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.amount), 1);
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * (width - 20) + 10;
    const y = height - 10 - ((d.amount / max) * (height - 20));
    return `${x},${y}`;
  });
  const path = `M ${pts.join(' L ')}`;
  const fill = `M ${pts[0]} L ${pts.join(' L ')} L ${(data.length - 1) / (data.length - 1) * (width - 20) + 10},${height} L 10,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#sparkGrad)" />
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Bar chart (horizontal, SVG) ───────────────────────────────────────

function HBar({ label, value, max, color = '#3b82f6', suffix = '' }: {
  label: string; value: number; max: number; color?: string; suffix?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-32 text-xs text-slate-600 truncate flex-shrink-0">{label}</span>
      <div className="flex-1 bg-slate-100 rounded-full h-2">
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-mono text-slate-700 w-20 text-right flex-shrink-0">
        {suffix || fmt(value)}
      </span>
    </div>
  );
}

// ── Hourly heatmap ────────────────────────────────────────────────────

function HourlyHeatmap({ data }: { data: Array<{ hour: number; label: string; amount: number }> }) {
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className="grid grid-cols-12 gap-1">
      {data.map((d) => {
        const intensity = d.amount / max;
        const bg = intensity > 0.7 ? 'bg-blue-600' : intensity > 0.4 ? 'bg-blue-400' : intensity > 0.1 ? 'bg-blue-200' : 'bg-slate-100';
        return (
          <div key={d.hour} className="flex flex-col items-center gap-0.5" title={`${d.label}: ${fmt(d.amount)}`}>
            <div className={`w-full aspect-square rounded ${bg}`} />
            <span className="text-[9px] text-slate-400">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────

type Tab = 'overview' | 'analytics' | 'inventory' | 'staff';

// ── Main page ─────────────────────────────────────────────────────────

export default function SalesRevenue() {
  const [tab, setTab] = useState<Tab>('overview');
  const [analyticsDays, setAnalyticsDays] = useState(90);
  const queryClient = useQueryClient();

  const dashQ = useQuery<DashboardResponse>({
    queryKey: ['pos', 'dashboard'],
    queryFn: () => api.get<DashboardResponse>('/pos/dashboard').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const syncStatusQ = useQuery<SyncStatusResponse>({
    queryKey: ['pos', 'sync-status'],
    queryFn: () => api.get<SyncStatusResponse>('/pos/sync-status').then((r) => r.data),
    staleTime: 60 * 1000,
    // Re-poll every 10 seconds so a manual sync's progress shows up
    refetchInterval: (q) => {
      const data = q.state.data;
      // No data → poll occasionally so the first run shows up
      if (!data) return 30_000;
      // If a sync ran in the last minute, poll faster to catch the next state
      const last = data.completedAt ?? data.lastSyncAt;
      if (last) {
        const ageMs = Date.now() - new Date(last).getTime();
        if (ageMs < 90_000) return 5_000;
      }
      return 60_000;
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post('/pos/sync').then((r) => r.data),
    onSuccess: () => {
      // After a few seconds, force a re-poll
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['pos', 'sync-status'] });
        void queryClient.invalidateQueries({ queryKey: ['pos'] });
      }, 5_000);
    },
  });

  const analyticsQ = useQuery<AnalyticsResponse>({
    queryKey: ['pos', 'analytics', analyticsDays],
    queryFn: () => api.get<AnalyticsResponse>(`/pos/analytics?days=${analyticsDays}`).then((r) => r.data),
    staleTime: 10 * 60 * 1000,
    enabled: tab === 'analytics',
  });

  const inventoryQ = useQuery<InventoryResponse>({
    queryKey: ['pos', 'inventory'],
    queryFn: () => api.get<InventoryResponse>('/pos/inventory').then((r) => r.data),
    staleTime: 60 * 60 * 1000, // 1 hour — items don't change often
    enabled: tab === 'inventory',
  });

  const staffQ = useQuery<StaffResponse>({
    queryKey: ['pos', 'staff'],
    queryFn: () => api.get<StaffResponse>('/pos/staff').then((r) => r.data),
    staleTime: 10 * 60 * 1000,
    enabled: tab === 'staff',
  });

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'overview', label: 'Overview', icon: TrendingUp },
    { id: 'analytics', label: 'Analytics', icon: BarChart3Icon },
    { id: 'inventory', label: 'Inventory', icon: Package },
    { id: 'staff', label: 'Staff', icon: Users },
  ];

  function refetchCurrent() {
    if (tab === 'overview') void dashQ.refetch();
    if (tab === 'analytics') void analyticsQ.refetch();
    if (tab === 'inventory') void inventoryQ.refetch();
    if (tab === 'staff') void staffQ.refetch();
  }

  const isFetching = dashQ.isFetching || analyticsQ.isFetching || inventoryQ.isFetching || staffQ.isFetching;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <Link to="/" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">Sales & Revenue</h1>
          <div className="ml-auto flex items-center gap-3">
            <SyncBar
              status={syncStatusQ.data}
              isSyncing={syncMutation.isPending}
              onSyncNow={() => syncMutation.mutate()}
            />
            <button
              onClick={refetchCurrent}
              disabled={isFetching}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              {isFetching ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6">
          <nav className="flex gap-0" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-6 py-8">

        {/* ── OVERVIEW TAB ── */}
        {tab === 'overview' && (
          <div className="space-y-6">
            {dashQ.isLoading && <LoadingState label="Loading sales data from Heartland…" />}
            {dashQ.isError && <ErrorState error={dashQ.error} />}
            {dashQ.data && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard label="Today" value={fmt(dashQ.data.today.totalAmount)} sub={`${dashQ.data.today.ticketCount} transactions`} icon={TrendingUp} color="blue" />
                  <StatCard label="Last 7 Days" value={fmt(dashQ.data.last7Days.totalAmount)} sub={`${dashQ.data.last7Days.ticketCount} transactions`} icon={ShoppingBag} color="green" />
                  <StatCard label="Last 30 Days" value={fmt(dashQ.data.last30Days.totalAmount)} sub={`${dashQ.data.last30Days.ticketCount} transactions`} icon={CreditCard} color="purple" />
                  <StatCard label="Year to Date" value={fmt(dashQ.data.yearToDate.totalAmount)} sub={`${dashQ.data.yearToDate.ticketCount} transactions`} icon={TrendingUp} color="amber" />
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4 text-xs text-slate-500">
                  Pulled from Heartland Retail payments (gross including 8.25% Denton sales tax). For tax-ready net revenue, use <em>Import from POS</em> in the CPA Tax Assistant.
                  {' '}Last sync: {relativeTime(dashQ.data.syncInfo?.lastSyncAt)}. Page loaded {new Date(dashQ.data.asOf).toLocaleTimeString()}.
                </div>
              </>
            )}
          </div>
        )}

        {/* ── ANALYTICS TAB ── */}
        {tab === 'analytics' && (
          <div className="space-y-6">
            {/* Period selector */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600">Period:</span>
              {[1, 7, 30, 60, 90, 180, 365].map((d) => (
                <button
                  key={d}
                  onClick={() => setAnalyticsDays(d)}
                  className={`px-3 py-1 text-sm rounded-full border transition ${
                    analyticsDays === d
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {d === 365 ? '1 yr' : d === 1 ? '1d' : `${d}d`}
                </button>
              ))}
            </div>

            {analyticsQ.isLoading && <LoadingState label="Crunching analytics…" />}
            {analyticsQ.isError && <ErrorState error={analyticsQ.error} />}
            {analyticsQ.data && (() => {
              const d = analyticsQ.data;
              return (
                <>
                  {/* Summary row */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <StatCard label="Total Revenue" value={fmt(d.summary.totalAmount)} sub={`${d.summary.totalCount.toLocaleString()} transactions`} icon={TrendingUp} color="blue" />
                    <StatCard label="Avg Ticket" value={fmtDec(d.summary.avgTicket)} sub="per transaction" icon={ShoppingBag} color="green" />
                    <StatCard label="Total Discounts" value={fmt(d.discountSummary.totalDiscounts)} sub={`${fmtPct(d.discountSummary.discountRate)} discount rate`} icon={Tag} color="amber" />
                  </div>

                  {/* Daily trend */}
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-1">Daily Revenue Trend</h3>
                    <p className="text-xs text-slate-500 mb-4">{fmtDate(d.fromDate)} – {fmtDate(d.toDate)}</p>
                    <Sparkline data={d.dailyTrend} height={100} />
                    <div className="flex justify-between text-xs text-slate-400 mt-1">
                      <span>{fmtDate(d.dailyTrend[0]?.date ?? d.fromDate)}</span>
                      <span>{fmtDate(d.dailyTrend[d.dailyTrend.length - 1]?.date ?? d.toDate)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Payment methods */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-slate-400" /> Payment Methods
                      </h3>
                      <div className="space-y-3">
                        {d.paymentMethods.map((pm) => (
                          <div key={pm.id}>
                            <HBar label={pm.name} value={pm.amount} max={d.paymentMethods[0]?.amount ?? 1} />
                            <p className="text-[10px] text-slate-400 ml-[8.5rem] mt-0.5">{pm.count} transactions · {fmtPct(pm.pct)}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Hourly heatmap */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-slate-400" /> Peak Hours
                      </h3>
                      <HourlyHeatmap data={d.hourlyHeatmap} />
                      <p className="text-xs text-slate-400 mt-3">Darker = more revenue. Based on local store time.</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Top customers */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-400" /> Top Customers
                      </h3>
                      {d.topCustomers.length === 0 ? (
                        <p className="text-sm text-slate-400">No named customer data in this period.</p>
                      ) : (
                        <div className="space-y-2">
                          {d.topCustomers.slice(0, 10).map((c) => (
                            <HBar key={c.name} label={c.name} value={c.amount} max={d.topCustomers[0]?.amount ?? 1} suffix={`${fmt(c.amount)} (${c.visits}x)`} />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Sales by rep */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-400" /> Sales by Rep
                      </h3>
                      {d.bySalesRep.length === 0 ? (
                        <p className="text-sm text-slate-400">No sales rep data in this period.</p>
                      ) : (
                        <div className="space-y-2">
                          {d.bySalesRep.map((r) => (
                            <HBar key={r.name} label={r.name} value={r.amount} max={d.bySalesRep[0]?.amount ?? 1} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* ── INVENTORY TAB ── */}
        {tab === 'inventory' && (
          <div className="space-y-6">
            {inventoryQ.isLoading && <LoadingState label="Loading item catalog…" />}
            {inventoryQ.isError && <ErrorState error={inventoryQ.error} />}
            {inventoryQ.data?.notReady && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                {inventoryQ.data.message ?? 'Inventory has not been synced yet.'} The first sync runs automatically every 6 hours, or click "Sync now" in the header to start one immediately.
              </div>
            )}
            {inventoryQ.data && !inventoryQ.data.notReady && (() => {
              const d = inventoryQ.data;
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatCard label="Total Items" value={d.summary.totalItems.toLocaleString()} sub={`${d.summary.activeItems.toLocaleString()} active in catalog`} icon={Package} color="blue" />
                    <StatCard label="Live Catalog" value={(d.summary.liveItems ?? d.summary.itemsWithCostData).toLocaleString()} sub="active + cost+price set" icon={Package} color="green" />
                    <StatCard label="Avg Gross Margin" value={fmtPct(d.summary.overallAvgMarginPct)} sub="across live items" icon={TrendingUp} color="purple" />
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Last Synced</p>
                      <p className="text-sm font-medium text-slate-700 mt-1">{relativeTime(d.cachedAt)}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{d.cachedAt ? new Date(d.cachedAt).toLocaleString() : '—'}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* By department */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4">By Department</h3>
                      <div className="space-y-3">
                        {d.byDepartment.slice(0, 12).map((dept) => (
                          <div key={dept.name}>
                            <HBar label={dept.name} value={dept.count} max={d.byDepartment[0]?.count ?? 1} suffix={`${dept.count} items`} />
                            <p className="text-[10px] text-slate-400 ml-[8.5rem] mt-0.5">Avg margin: {fmtPct(dept.avgMargin)}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* By brand */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4">Top Brands</h3>
                      <div className="space-y-2">
                        {d.byBrand.slice(0, 15).map((b) => (
                          <HBar key={b.name} label={b.name} value={b.count} max={d.byBrand[0]?.count ?? 1} suffix={`${b.count} items`} />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Low margin items */}
                  {d.lowMarginItems.length > 0 && (
                    <div className="bg-white rounded-lg border border-amber-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
                        <Tag className="w-4 h-4 text-amber-500" /> Low Margin Items (&lt;20%)
                      </h3>
                      <p className="text-xs text-slate-500 mb-4">These items may be priced too low relative to cost. Review for repricing opportunities.</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th className="text-left py-2 text-slate-500 font-medium">SKU</th>
                              <th className="text-left py-2 text-slate-500 font-medium">Description</th>
                              <th className="text-right py-2 text-slate-500 font-medium">Cost</th>
                              <th className="text-right py-2 text-slate-500 font-medium">Price</th>
                              <th className="text-right py-2 text-slate-500 font-medium">Margin</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {d.lowMarginItems.map((item) => (
                              <tr key={item.id}>
                                <td className="py-1.5 text-slate-500 font-mono">{item.sku}</td>
                                <td className="py-1.5 text-slate-700 max-w-[200px] truncate">{item.description}</td>
                                <td className="py-1.5 text-right text-slate-600">{fmtDec(item.cost)}</td>
                                <td className="py-1.5 text-right text-slate-600">{fmtDec(item.price)}</td>
                                <td className={`py-1.5 text-right font-medium ${item.margin < 10 ? 'text-red-600' : 'text-amber-600'}`}>{fmtPct(item.margin)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── STAFF TAB ── */}
        {tab === 'staff' && (
          <div className="space-y-6">
            {staffQ.isLoading && <LoadingState label="Loading staff performance…" />}
            {staffQ.isError && <ErrorState error={staffQ.error} />}
            {staffQ.data && (() => {
              const d = staffQ.data;
              const topAmount = d.staff[0]?.ytdAmount ?? 1;
              return (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-600">{d.year} Year-to-Date · {d.totalUsers} users in system</p>
                    <p className="text-xs text-slate-400">As of {new Date(d.asOf).toLocaleString()}</p>
                  </div>

                  {d.staff.length === 0 ? (
                    <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-sm text-slate-500">
                      No sales rep data available yet. Sales rep names are pulled from ticket records — they'll appear here once the cache refreshes with ticket data.
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Name</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">YTD Revenue</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Active Days</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Avg / Day</th>
                            <th className="px-4 py-3 w-40"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {d.staff.map((s, i) => (
                            <tr key={s.rawName} className="hover:bg-slate-50">
                              <td className="px-4 py-3 font-medium text-slate-900">
                                {i === 0 && <span className="mr-1.5 text-amber-500">★</span>}
                                {s.name}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-slate-700">{fmt(s.ytdAmount)}</td>
                              <td className="px-4 py-3 text-right text-slate-500">{s.activeDays}</td>
                              <td className="px-4 py-3 text-right font-mono text-slate-600">{fmt(s.avgPerDay)}</td>
                              <td className="px-4 py-3">
                                <div className="bg-slate-100 rounded-full h-1.5">
                                  <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${(s.ytdAmount / topAmount) * 100}%` }} />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

      </main>
    </div>
  );
}

// ── Utility components ────────────────────────────────────────────────

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500 py-8">
      <Spinner size="sm" />
      {label}
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  const msg = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
    ?? (error instanceof Error ? error.message : 'Failed to load data.');
  return (
    <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
      {msg}
    </div>
  );
}

// Inline icon to avoid import issues
function BarChart3Icon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

// SyncBar — shows last sync time + manual "Sync now" button
function SyncBar({
  status,
  isSyncing,
  onSyncNow,
}: {
  status?: SyncStatusResponse;
  isSyncing: boolean;
  onSyncNow: () => void;
}) {
  const last = status?.completedAt ?? status?.lastSyncAt ?? null;
  const recentlyCompleted = last && Date.now() - new Date(last).getTime() < 90_000;
  const inProgress = isSyncing || (recentlyCompleted && !status?.durationMs);
  const hasError = status?.status === 'error';

  return (
    <div className="flex items-center gap-2">
      <div className="text-xs text-slate-500" title={last ? new Date(last).toLocaleString() : 'No sync yet'}>
        <span className="hidden sm:inline">Synced</span>{' '}
        <span className={`font-medium ${hasError ? 'text-red-600' : 'text-slate-700'}`}>
          {inProgress ? 'syncing…' : relativeTime(last)}
        </span>
      </div>
      <button
        onClick={onSyncNow}
        disabled={isSyncing}
        title="Pull fresh data from Heartland (takes 30-60 seconds)"
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50 transition"
      >
        <CloudDownload className={`w-3.5 h-3.5 ${isSyncing ? 'animate-pulse' : ''}`} />
        {isSyncing ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}
