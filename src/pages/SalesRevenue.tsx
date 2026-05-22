import { useState, useMemo } from 'react';
import { Fragment } from 'react';
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
  Download,
  AlertCircle,
  StickyNote,
  X,
  Trophy,
  Info,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useAdmin } from '../lib/admin';
import Spinner from '../components/Spinner';
import CentralTimeBadge from '../components/CentralTimeBadge';
import { downloadCsvSections, stampedName, csvNum, type CsvSection } from '../lib/csv';
import SalesChat from '../components/SalesChat';
import VendorHealthCard from '../components/VendorHealthCard';
import DailyHighlightsCard from '../components/DailyHighlightsCard';
import OrderRow from '../components/OrderRow';

// ── Types ─────────────────────────────────────────────────────────────

interface DashboardResponse {
  today: { totalAmount: number; ticketCount: number };
  last7Days: { totalAmount: number; ticketCount: number };
  last30Days: { totalAmount: number; ticketCount: number };
  yearToDate: { totalAmount: number; ticketCount: number };
  selectedRange?: { totalAmount: number; ticketCount: number };
  selectedRangeStart?: string;
  selectedRangeEnd?: string;
  lastYear?: {
    today: { totalAmount: number; ticketCount: number };
    last7Days: { totalAmount: number; ticketCount: number };
    last30Days: { totalAmount: number; ticketCount: number };
    yearToDate: { totalAmount: number; ticketCount: number };
    selectedRange?: { totalAmount: number; ticketCount: number };
  };
  hourly?: {
    today: number[];
    lastYear: number[];
  };
  alerts?: {
    openOrders: number;
    lowStock: number;
  };
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
  summary: {
    totalItems: number;
    activeItems: number;
    liveItems?: number;
    itemsWithCostData: number;
    overallAvgMarginPct: number;
    totalQtyOnHand?: number;
    locationId?: number;
  };
  byDepartment: Array<{ name: string; count: number; avgMargin: number; totalCost: number; totalPrice: number; totalQty?: number }>;
  byBrand: Array<{ name: string; count: number; totalRevenue?: number; totalQty?: number }>;
  topMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number; brand: string; department: string; qty_on_hand?: number }>;
  lowMarginItems: Array<{ id: number; sku: string; description: string; cost: number; price: number; margin: number; qty_on_hand?: number }>;
  lowStockItems?: Array<{ item_id: number; sku: string; description: string; qty_on_hand: number; qty_available: number; price: number; brand: string; department: string }>;
  cached: boolean;
  cachedAt: string | null;
  notReady?: boolean;
  message?: string;
}

interface OrderLine {
  id: number;
  item_id: number;
  qty: number;
  qty_received: number;
  qty_open: number;
  unit_cost: number;
  extended_cost?: number;
  original_cost?: number;
  status?: string;
  name?: string;
  sku?: string;
  brand?: string;
  size?: string;
  color?: string;
  width?: string;
  department?: string;
  style_number?: string;
}

interface PurchasingResponse {
  vendors: Array<{ id: number; name?: string; public_id?: string; active?: boolean }>;
  vendorCount: number;
  vendorRank: Array<{ vendorId: number; vendorName: string; totalReceivedQty: number; openOrders?: number; totalOrders?: number; rank: number }>;
  orders: Array<{ id: number; public_id?: string; status?: string; vendor_id?: number; vendorName?: string; total_qty?: number; total_cost?: number; total_open_qty?: number; created_at?: string }>;
  totalOrders: number;
  openOrderCount: number;
  cachedAt: string | null;
  notReady?: boolean;
  message?: string;
}

interface ReportingResponse {
  fromDate: string;
  toDate: string;
  yearStart?: string;
  summary: {
    totalNetSales: number;
    totalTransactions: number;
    totalNetMargin: number | null;
    avgNetMarginPct: number | null;
    marginAvailable?: boolean;
    last30Days?: { netSales: number; transactions: number };
  };
  dailyRows: Array<{ 'date.date'?: string; 'source_sales.net_sales'?: number; 'source_sales.transaction_count'?: number; 'source_sales.net_margin'?: number }>;
  monthRows?: Array<{ 'date.month_of_year'?: string; 'date.year'?: string; 'source_sales.net_sales'?: number; 'source_sales.transaction_count'?: number; 'source_sales.net_margin'?: number }>;
  brandRows: Array<{ 'item.custom@brand'?: string; 'source_sales.net_sales'?: number; 'source_sales.net_qty_sold'?: number; 'source_sales.net_margin'?: number; 'source_sales.transaction_count'?: number; variantCount?: number; variants?: string[]; isNullBrand?: boolean }>;
  returnRows?: Array<{ 'item.custom@brand'?: string; 'source_sales.gross_sales'?: number; 'source_sales.gross_returns'?: number; 'source_sales.gross_qty_sold'?: number; 'source_sales.gross_qty_returned'?: number }>;
  customerInsights?: {
    totalCustomers: number;
    repeatCustomers: number;
    newCustomers: number;
    repeatRate: number;
    repeatRevenue: number;
    repeatRevenuePct: number;
  };
  cachedAt: string | null;
  notReady?: boolean;
  message?: string;
}

interface StaffResponse {
  /** Time-window descriptors */
  period?: 'today' | '7d' | '30d' | 'monthly' | 'ytd' | 'custom';
  label?: string;
  fromDate?: string;
  toDate?: string;
  /** Legacy field for backward compat */
  year?: string;
  staff: Array<{ name: string; rawName: string; amount?: number; ytdAmount?: number; activeDays: number; avgPerDay: number }>;
  totalUsers: number;
  asOf: string;
}

interface InsightsResponse {
  scope?: string;
  selectedYears?: number[];
  availableYears?: number[];
  fromDate?: string;
  toDate?: string;
  summary?: {
    totalNetSales: number;
    totalTransactions: number;
    totalNetMargin: number | null;
    marginAvailable?: boolean;
  };
  brandRows?: Array<{ 'item.custom@brand'?: string; 'source_sales.net_sales'?: number; 'source_sales.net_margin'?: number; 'source_sales.transaction_count'?: number; 'source_sales.net_qty_sold'?: number; variantCount?: number; isNullBrand?: boolean }>;
  returnRows?: Array<{ 'item.custom@brand'?: string; 'source_sales.gross_sales'?: number; 'source_sales.gross_returns'?: number; 'source_sales.gross_qty_sold'?: number; 'source_sales.gross_qty_returned'?: number }>;
  customerInsights?: {
    totalCustomers: number;
    repeatCustomers: number;
    newCustomers: number;
    repeatRate: number;
    repeatRevenue: number;
    repeatRevenuePct: number;
  };
  cachedAt?: string | null;
  notReady?: boolean;
  message?: string;
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

// ── Vendor contact directory ──────────────────────────────────────────
// Sourced from official brand websites (May 2026). Content rephrased for
// compliance with licensing restrictions.

const VENDOR_CONTACTS: Record<string, { phone?: string; email?: string; website?: string; rep?: { name: string; phone?: string; email?: string; account?: string } }> = {
  'BROOKS':           { phone: '1-800-227-6657', email: 'retailer@brooksrunning.com', website: 'https://www.brooksrunning.com', rep: { name: 'Jacob Brooks — Territory Mgr, North TX/OK', phone: '239-839-7971', email: 'Jacob.brooks@brooksrunning.com' } },
  'SAUCONY':          { phone: '1-800-282-6575', email: 'customerservice@saucony.com', website: 'https://www.saucony.com' },
  'DANSKO':           { phone: '1-800-326-7564', email: 'moreinfo@dansko.com', website: 'https://www.dansko.com' },
  'VIONIC':           { phone: '1-800-832-9255', email: 'info@vionicshoes.com', website: 'https://www.vionicshoes.com' },
  'AETREX':           { phone: '1-888-526-2739', email: 'help@aetrex.com', website: 'https://www.aetrex.com' },
  'DREW':             { phone: '1-800-837-3739', email: 'customerservice@drewshoe.com', website: 'https://www.drewshoe.com' },
  'FINN USA':         { phone: '1-877-353-6642', email: 'orders@finncomfortusa.net', website: 'https://www.finncomfortusa.net' },
  'MEPHISTO':         { phone: '1-615-771-5900', email: 'info@mephistousa.com', website: 'https://mephistousa.com' },
  'ROCKPORT':         { phone: '1-800-762-5767', email: 'consumercare@help.rockport.com', website: 'https://www.rockport.com' },
  'OLUKAI':           { phone: '1-877-789-5131', email: 'info@olukai.com', website: 'https://olukai.com' },
  'HAFLINGER COMFORT FOOTWEAR': { phone: '1-800-551-7556', email: 'help@haflinger.com', website: 'https://us.haflinger.com' },
  'WALDLAUFER INC':   { website: 'https://waldlauferfootwear.com' },
  'WALDLAUFER':       { website: 'https://waldlauferfootwear.com' },
  'GIESSWEIN':        { phone: '+43-5337-6135-0', email: 'shop@giesswein.com', website: 'https://us.giesswein.com' },
  'SANITA':           { website: 'https://www.sanita.com' },
  'FEETURES':         { email: 'hello@feetures.com', website: 'https://feetures.com' },
  'CALERES':          { phone: '1-888-509-8200', email: 'retailerservices@caleres.com', website: 'https://www.caleres.com' },
  'P.W.MINOR, LLC':   { phone: '1-585-343-1500', email: 'info@pwminor.com', website: 'https://www.pwminor.com' },
  'PEDAG INTERNATIONAL': { email: 'info@pedag.com', website: 'https://pedagusa.com' },
  'EARTH BRAND SHOES': { website: 'https://www.earthbrands.com' },
  'DOCTOR SPECIFIED': { website: 'https://www.doctorspecified.com' },
  'KUMFS/ZIERA':      { website: 'https://www.zierausa.com' },
  'YALEET':           { phone: '516-465-6268', website: 'https://www.naot.com', rep: { name: 'Joey DeWitt — Sales Rep', phone: '817-975-3365' } },
  'AMERIBAG':         { phone: '1-800-AMERIBAG', website: 'https://www.ameribag.com' },
  'ANA-TECH':         { website: 'https://www.ana-tech.com' },
  'BERKEMANNUSA C/O GARRY WILLIS': { website: 'https://www.berkemann.com' },
  'BERKEMANNUSA  C/O GARRY WILLIS': { website: 'https://www.berkemann.com' },
  'FIDELIO':                { phone: '414-778-2288', website: 'https://www.berkemann.com' },
  'FIDELIO (RUBY LEATHER)': { phone: '414-778-2288', website: 'https://www.berkemann.com' },
  'JUSTIN BLAIR':     { phone: '800-566-0664', website: 'https://www.burtendistribution.com' },
  'FLAGSHIP BRANDS':  { website: 'https://www.flagshipbrands.com' },
  'NEIL M':           { website: 'https://www.neilmshoes.com' },
  'REJUVA':           { website: 'https://www.rejuvafootwear.com' },
  'SHU-RE-NU':        { email: 'tbogumill@shu-re-nu.com', rep: { name: 'Tammy Bogumill' } },
  'INSTRIDE':         { phone: '866-969-3338', website: 'https://www.xeleroshoes.com' },
  'InStride':         { phone: '866-969-3338', website: 'https://www.xeleroshoes.com' },
  'THORIO':           { website: 'https://www.thorio.com' },
  'Thorlo':           { website: 'https://www.thorlo.com' },
  'THORLO':           { website: 'https://www.thorlo.com' },
  'Hoka':             { phone: '1-888-463-4652', website: 'https://www.hoka.com' },
  'HOKA':             { phone: '1-888-463-4652', website: 'https://www.hoka.com' },
  'APEX':             { phone: '800-252-2739', email: 'Lisa.fryberger@ohi.net', website: 'https://www.apexfoot.com', rep: { name: 'Lisa Fryberger', phone: '631-615-4176', account: '97378' } },
  'PEDORS':           { phone: '1-800-750-6729', website: 'https://www.pedors.com' },
  'PEDIFIX':          { phone: '1-800-424-5561', website: 'https://www.pedifix.com' },
};

// Vendor display name overrides — append known trade names in parentheses
const VENDOR_DISPLAY_OVERRIDES: Record<string, string> = {
  'YALEET': 'Yaleet (NAOT)',
};

function displayVendorName(raw: string | undefined | null, fallback: string): string {
  if (!raw) return fallback;
  const override = VENDOR_DISPLAY_OVERRIDES[raw.toUpperCase()];
  return override ?? raw;
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

// ── BenchmarkTip — hover tooltip showing expected benchmark for a metric ──
function BenchmarkTip({ lines }: { lines: string[] }) {
  return (
    <div className="relative group inline-flex items-center">
      <Info className="w-3.5 h-3.5 text-slate-400 hover:text-blue-500 cursor-help transition-colors" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 w-64 pointer-events-none">
        <div className="bg-slate-800 text-white text-[11px] rounded-lg px-3 py-2.5 shadow-xl leading-relaxed">
          <p className="font-semibold text-slate-200 mb-1.5 text-xs">Benchmark for your store</p>
          {lines.map((line, i) => (
            <p key={i} className="text-slate-300">{line}</p>
          ))}
        </div>
        <div className="w-2 h-2 bg-slate-800 rotate-45 mx-auto -mt-1" />
      </div>
    </div>
  );
}

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

// ── LineChart with axes + hover tooltip (SVG, no library) ─────────────

function LineChart({
  data,
  width = 720,
  height = 260,
  yLabel = 'Amount',
  xLabel = 'Date',
  formatY,
  tooltipExtra,
}: {
  data: Array<{ date: string; amount: number; meta?: Record<string, unknown> }>;
  width?: number;
  height?: number;
  yLabel?: string;
  xLabel?: string;
  formatY?: (n: number) => string;
  tooltipExtra?: (point: { date: string; amount: number; meta?: Record<string, unknown> }) => string | null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const padding = { top: 16, right: 16, bottom: 38, left: 64 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const fmtCurrency = (n: number) =>
    `$${n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : n.toFixed(0)}`;
  const yFmt = formatY ?? fmtCurrency;

  const { points, yTicks, xTickIdxs, maxY } = useMemo(() => {
    if (!data.length) {
      return { points: [] as Array<{ x: number; y: number }>, yTicks: [] as number[], xTickIdxs: [] as number[], maxY: 0 };
    }
    const amounts = data.map((d) => d.amount);
    const max = Math.max(...amounts, 1);
    // Round max up to a "nice" tick value
    const niceMax = (() => {
      if (max <= 100) return Math.ceil(max / 10) * 10;
      if (max <= 1000) return Math.ceil(max / 100) * 100;
      if (max <= 10000) return Math.ceil(max / 500) * 500;
      return Math.ceil(max / 1000) * 1000;
    })();
    const ticks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];
    const pts = data.map((d, i) => ({
      x: padding.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
      y: padding.top + innerH - (d.amount / niceMax) * innerH,
    }));
    // 4–5 X-axis ticks evenly spaced
    const tickCount = Math.min(5, data.length);
    const idxs = Array.from({ length: tickCount }, (_, i) =>
      Math.round((i / Math.max(tickCount - 1, 1)) * (data.length - 1))
    );
    return { points: pts, yTicks: ticks, xTickIdxs: Array.from(new Set(idxs)), maxY: niceMax };
  }, [data, innerW, innerH, padding.left, padding.top]);

  if (!data.length) {
    return (
      <div className="text-xs text-slate-400 italic py-8 text-center">No data to display.</div>
    );
  }

  const path = `M ${points.map((p) => `${p.x},${p.y}`).join(' L ')}`;
  const fill = `${path} L ${points[points.length - 1].x},${padding.top + innerH} L ${points[0].x},${padding.top + innerH} Z`;

  const fmtTickDate = (s: string) => {
    if (!s) return '';
    // Force midday Central interpretation to avoid TZ off-by-one
    const dt = new Date(s + 'T12:00:00');
    if (isNaN(dt.getTime())) return s;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  };
  const fmtFullDate = (s: string) => {
    if (!s) return '';
    const dt = new Date(s + 'T12:00:00');
    if (isNaN(dt.getTime())) return s;
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  };

  const hoverPt = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverData = hoverIdx !== null ? data[hoverIdx] : null;

  // Tooltip positioning: keep inside chart bounds
  const tooltipW = 200;
  const tooltipH = 64;
  let tooltipX = hoverPt ? hoverPt.x + 12 : 0;
  let tooltipY = hoverPt ? hoverPt.y - tooltipH - 8 : 0;
  if (hoverPt && tooltipX + tooltipW > width - 4) tooltipX = hoverPt.x - tooltipW - 12;
  if (hoverPt && tooltipY < 4) tooltipY = hoverPt.y + 12;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="lineChartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y gridlines + tick labels */}
        {yTicks.map((t, i) => {
          const y = padding.top + innerH - (t / (maxY || 1)) * innerH;
          return (
            <g key={`y-${i}`}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={y}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth={1}
                strokeDasharray={i === 0 ? '0' : '3,3'}
              />
              <text
                x={padding.left - 8}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="#94a3b8"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
              >
                {yFmt(t)}
              </text>
            </g>
          );
        })}

        {/* X-axis line */}
        <line
          x1={padding.left}
          x2={padding.left + innerW}
          y1={padding.top + innerH}
          y2={padding.top + innerH}
          stroke="#cbd5e1"
          strokeWidth={1}
        />

        {/* X-axis tick labels */}
        {xTickIdxs.map((idx) => {
          const p = points[idx];
          const d = data[idx];
          if (!p || !d) return null;
          return (
            <text
              key={`x-${idx}`}
              x={p.x}
              y={padding.top + innerH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="#94a3b8"
            >
              {fmtTickDate(d.date)}
            </text>
          );
        })}

        {/* Axis labels */}
        <text
          x={padding.left + innerW / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize={11}
          fill="#64748b"
          fontWeight={500}
        >
          {xLabel}
        </text>
        <text
          x={14}
          y={padding.top + innerH / 2}
          transform={`rotate(-90 14 ${padding.top + innerH / 2})`}
          textAnchor="middle"
          fontSize={11}
          fill="#64748b"
          fontWeight={500}
        >
          {yLabel}
        </text>

        {/* Filled area + line */}
        <path d={fill} fill="url(#lineChartGrad)" />
        <path d={path} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* Data points */}
        {points.map((p, i) => (
          <circle
            key={`pt-${i}`}
            cx={p.x}
            cy={p.y}
            r={hoverIdx === i ? 5 : 3}
            fill={hoverIdx === i ? '#1d4ed8' : '#3b82f6'}
            stroke="#fff"
            strokeWidth={1.5}
          />
        ))}

        {/* Hover crosshair */}
        {hoverPt && (
          <line
            x1={hoverPt.x}
            x2={hoverPt.x}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#94a3b8"
            strokeWidth={1}
            strokeDasharray="3,3"
          />
        )}

        {/* Invisible hit areas for hover */}
        {points.map((p, i) => {
          const prevX = i === 0 ? padding.left : (points[i - 1].x + p.x) / 2;
          const nextX = i === points.length - 1 ? padding.left + innerW : (p.x + points[i + 1].x) / 2;
          return (
            <rect
              key={`hit-${i}`}
              x={prevX}
              y={padding.top}
              width={Math.max(nextX - prevX, 1)}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseMove={() => setHoverIdx(i)}
              style={{ cursor: 'crosshair' }}
            />
          );
        })}

        {/* Tooltip */}
        {hoverPt && hoverData && (
          <g pointerEvents="none">
            <rect
              x={tooltipX}
              y={tooltipY}
              width={tooltipW}
              height={tooltipH}
              rx={6}
              ry={6}
              fill="#0f172a"
              opacity={0.95}
            />
            <text x={tooltipX + 10} y={tooltipY + 18} fontSize={11} fill="#cbd5e1">
              {fmtFullDate(hoverData.date)}
            </text>
            <text x={tooltipX + 10} y={tooltipY + 36} fontSize={13} fill="#fff" fontWeight={600}>
              {yFmt(hoverData.amount)}
            </text>
            {tooltipExtra && tooltipExtra(hoverData) && (
              <text x={tooltipX + 10} y={tooltipY + 52} fontSize={10} fill="#94a3b8">
                {tooltipExtra(hoverData)}
              </text>
            )}
          </g>
        )}
      </svg>
    </div>
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

type Tab = 'overview' | 'analytics' | 'inventory' | 'vendors' | 'staff' | 'purchasing' | 'reporting' | 'insights';

// ── Main page ─────────────────────────────────────────────────────────

export default function SalesRevenue() {
  const [tab, setTab] = useState<Tab>('overview');
  const { isVisible } = useAdmin();
  // Memoize per-feature visibility flags so the values are stable across renders
  const showTotalRevenueCard = isVisible('sales.trends.totalRevenue');
  const showAvgTicketCard = isVisible('sales.trends.avgTicket');
  const showReportingTab = isVisible('sales.tab.reporting');
  const [analyticsDays, setAnalyticsDays] = useState(7);
  const [stockBrandFilter, setStockBrandFilter] = useState('');

  // ── Overview date filter ──────────────────────────────────────────
  // Helper: YYYY-MM-DD string for a date N days ago (Central Time)
  function ctDateStr(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  function startOfWeek(): string {
    const d = new Date();
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  function startOfMonth(): string {
    return `${ctDateStr(0).slice(0, 7)}-01`;
  }
  function startOfYear(): string {
    return `${ctDateStr(0).slice(0, 4)}-01-01`;
  }

  type DatePreset =
    | 'today' | 'yesterday'
    | 'week_to_date' | 'last_week'
    | 'last_3_weeks'
    | 'month_to_date' | 'last_month'
    | 'last_3_months' | 'last_6_months' | 'last_12_months'
    | 'year_to_date' | 'last_year'
    | 'custom';

  const PRESET_LABELS: Record<DatePreset, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    week_to_date: 'Week to Date',
    last_week: 'Last Week',
    last_3_weeks: 'Last 3 Weeks',
    month_to_date: 'Month to Date',
    last_month: 'Last Month',
    last_3_months: 'Last 3 Months',
    last_6_months: 'Last 6 Months',
    last_12_months: 'Last 12 Months',
    year_to_date: 'Year to Date',
    last_year: 'Last Year',
    custom: 'Custom',
  };

  function presetToDates(preset: DatePreset): { start: string; end: string } {
    const today = ctDateStr(0);
    const yesterday = ctDateStr(1);
    switch (preset) {
      case 'today':         return { start: today, end: today };
      case 'yesterday':     return { start: yesterday, end: yesterday };
      case 'week_to_date':  return { start: startOfWeek(), end: today };
      case 'last_week': {
        const d = new Date();
        const day = d.getDay();
        const endOfLastWeek = new Date(d); endOfLastWeek.setDate(d.getDate() - day - 1);
        const startOfLastWeek = new Date(endOfLastWeek); startOfLastWeek.setDate(endOfLastWeek.getDate() - 6);
        const fmt = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
        return { start: fmt(startOfLastWeek), end: fmt(endOfLastWeek) };
      }
      case 'last_3_weeks':  return { start: ctDateStr(21), end: today };
      case 'month_to_date': return { start: startOfMonth(), end: today };
      case 'last_month': {
        const d = new Date();
        const firstOfThisMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        const lastOfLastMonth = new Date(firstOfThisMonth); lastOfLastMonth.setDate(0);
        const firstOfLastMonth = new Date(lastOfLastMonth.getFullYear(), lastOfLastMonth.getMonth(), 1);
        const fmt = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
        return { start: fmt(firstOfLastMonth), end: fmt(lastOfLastMonth) };
      }
      case 'last_3_months':  return { start: ctDateStr(90), end: today };
      case 'last_6_months':  return { start: ctDateStr(180), end: today };
      case 'last_12_months': return { start: ctDateStr(365), end: today };
      case 'year_to_date':   return { start: startOfYear(), end: today };
      case 'last_year': {
        const yr = parseInt(today.slice(0, 4), 10) - 1;
        return { start: `${yr}-01-01`, end: `${yr}-12-31` };
      }
      case 'custom':
      default:               return { start: today, end: today };
    }
  }

  const [datePreset, setDatePreset] = useState<DatePreset>('custom');
  const initialDates = presetToDates('custom');
  const [filterStart, setFilterStart] = useState<string>(initialDates.start);
  const [filterEnd, setFilterEnd] = useState<string>(initialDates.end);

  function applyPreset(preset: DatePreset) {
    setDatePreset(preset);
    const { start, end } = presetToDates(preset);
    setFilterStart(start);
    setFilterEnd(end);
  }

  // Staff date selector — defaults to Month-to-date (most useful for
  // commission decisions; YTD is one click away).
  type StaffPeriod = 'today' | '7d' | '30d' | 'monthly' | 'ytd' | 'custom';
  const [staffPeriod, setStaffPeriod] = useState<StaffPeriod>('monthly');
  const [staffCustomStart, setStaffCustomStart] = useState<string>('');
  const [staffCustomEnd, setStaffCustomEnd] = useState<string>('');

  // Insights year selector — defaults to current Central-Time year
  const currentYearStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
  }).format(new Date());
  const [insightsYear, setInsightsYear] = useState<string>(currentYearStr);

  const queryClient = useQueryClient();

  const dashQ = useQuery<DashboardResponse>({
    queryKey: ['pos', 'dashboard', filterStart, filterEnd],
    queryFn: () => api.get<DashboardResponse>(`/pos/dashboard?start=${filterStart}&end=${filterEnd}`).then((r) => r.data),
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
    enabled: tab === 'analytics' || tab === 'overview' || tab === 'purchasing',
  });

  const inventoryQ = useQuery<InventoryResponse>({
    queryKey: ['pos', 'inventory'],
    queryFn: () => api.get<InventoryResponse>('/pos/inventory').then((r) => r.data),
    staleTime: 60 * 60 * 1000, // 1 hour — items don't change often
    enabled: tab === 'inventory' || tab === 'insights',
  });

  const staffQ = useQuery<StaffResponse>({
    queryKey: ['pos', 'staff', staffPeriod, staffCustomStart, staffCustomEnd],
    queryFn: () => {
      const params = new URLSearchParams({ period: staffPeriod });
      if (staffPeriod === 'custom') {
        if (staffCustomStart) params.set('start', staffCustomStart);
        if (staffCustomEnd) params.set('end', staffCustomEnd);
      }
      return api.get<StaffResponse>(`/pos/staff?${params.toString()}`).then((r) => r.data);
    },
    staleTime: 10 * 60 * 1000,
    enabled:
      tab === 'staff' &&
      (staffPeriod !== 'custom' || (!!staffCustomStart && !!staffCustomEnd)),
  });

  const purchasingQ = useQuery<PurchasingResponse>({
    queryKey: ['pos', 'purchasing'],
    queryFn: () => api.get<PurchasingResponse>('/pos/purchasing').then((r) => r.data),
    staleTime: 30 * 60 * 1000,
    enabled: tab === 'purchasing' || tab === 'vendors',
  });

  const reportingQ = useQuery<ReportingResponse>({
    queryKey: ['pos', 'reporting'],
    queryFn: () => api.get<ReportingResponse>('/pos/reporting').then((r) => r.data),
    staleTime: 30 * 60 * 1000,
    enabled: tab === 'reporting' || tab === 'insights' || tab === 'overview',
  });

  const insightsQ = useQuery<InsightsResponse>({
    queryKey: ['pos', 'insights', insightsYear],
    queryFn: () =>
      api
        .get<InsightsResponse>(`/pos/insights?year=${encodeURIComponent(insightsYear)}`)
        .then((r) => r.data),
    staleTime: 15 * 60 * 1000,
    enabled: tab === 'insights',
  });

  // ── Vendor settings — persisted in DynamoDB via API ─────────────
  // Replaces the old localStorage approach so state survives redeployments
  // and is consistent across all browsers and devices.

  interface VendorOverride {
    displayName?: string;
    phone?: string;
    email?: string;
    website?: string;
    repName?: string;
    repPhone?: string;
    repEmail?: string;
    repTitle?: string;
  }
  interface VendorContact {
    id: string;
    name?: string;
    title?: string;
    phone?: string;
    email?: string;
  }
  interface VendorSettingsResponse {
    activeAccounts: string[];
    discontinuedVendors: string[];
    contactedVendors: string[];
    contactNotes: Record<string, string>;
    vendorOverrides: Record<string, VendorOverride>;
    customContacts: Record<string, VendorContact[]>;
    updatedAt: string | null;
  }

  const vendorSettingsQ = useQuery<VendorSettingsResponse>({
    queryKey: ['pos', 'vendor-settings'],
    queryFn: () => api.get<VendorSettingsResponse>('/pos/vendor-settings').then((r) => r.data),
    staleTime: Infinity, // user-edited data — only refetch on explicit invalidation
  });

  const vendorSettingsMutation = useMutation({
    mutationFn: (payload: Partial<VendorSettingsResponse>) =>
      api.put('/pos/vendor-settings', payload).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pos', 'vendor-settings'] });
    },
  });

  // Derive local state from the query result (falls back to empty while loading)
  const activeAccounts = new Set<string>(vendorSettingsQ.data?.activeAccounts ?? []);
  const discontinuedVendors = new Set<string>(vendorSettingsQ.data?.discontinuedVendors ?? []);
  const contactedVendors = new Set<string>(vendorSettingsQ.data?.contactedVendors ?? []);
  const contactNotes: Record<string, string> = vendorSettingsQ.data?.contactNotes ?? {};
  // vendorOverrides keys come back as strings from JSON; cast to number-keyed for compat
  const vendorOverrides: Record<number, VendorOverride> = Object.fromEntries(
    Object.entries(vendorSettingsQ.data?.vendorOverrides ?? {}).map(([k, v]) => [Number(k), v])
  );
  const customContacts: Record<number, VendorContact[]> = Object.fromEntries(
    Object.entries(vendorSettingsQ.data?.customContacts ?? {}).map(([k, v]) => [Number(k), v])
  );

  // Helper: build the full settings payload merging a partial change over current data
  function buildSettingsUpdate(patch: Partial<VendorSettingsResponse>): Partial<VendorSettingsResponse> {
    return {
      activeAccounts: [...activeAccounts],
      discontinuedVendors: [...discontinuedVendors],
      contactedVendors: [...contactedVendors],
      contactNotes,
      vendorOverrides: Object.fromEntries(Object.entries(vendorOverrides).map(([k, v]) => [String(k), v])),
      customContacts: Object.fromEntries(Object.entries(customContacts).map(([k, v]) => [String(k), v])),
      ...patch,
    };
  }

  const [editingVendorCard, setEditingVendorCard] = useState<number | null>(null);
  const [vendorCardDraft, setVendorCardDraft] = useState<VendorOverride>({});

  function handleVendorAccountToggle(key: string, vendorName: string, checked: boolean) {
    if (checked) {
      if (!window.confirm(`Mark "${vendorName}" as having an active account?`)) return;
      const next = new Set(activeAccounts);
      next.add(key);
      // Clear the contacted flag (account is now active so contacted state is moot)
      // but KEEP the note — it's valuable history about how the relationship started.
      const nextContacted = new Set(contactedVendors);
      nextContacted.delete(key);
      vendorSettingsMutation.mutate(buildSettingsUpdate({
        activeAccounts: [...next],
        contactedVendors: [...nextContacted],
      }));
    } else {
      if (!window.confirm(`Remove the active account mark for "${vendorName}"?`)) return;
      const next = new Set(activeAccounts);
      next.delete(key);
      vendorSettingsMutation.mutate(buildSettingsUpdate({ activeAccounts: [...next] }));
    }
  }

  function handleDiscontinuedToggle(key: string, vendorName: string) {
    const isCurrentlyDiscontinued = discontinuedVendors.has(key);
    if (isCurrentlyDiscontinued) {
      if (!window.confirm(`Remove "will discontinue" flag from "${vendorName}"?`)) return;
      const next = new Set(discontinuedVendors);
      next.delete(key);
      vendorSettingsMutation.mutate(buildSettingsUpdate({ discontinuedVendors: [...next] }));
    } else {
      if (!window.confirm(`Mark "${vendorName}" as will discontinue?`)) return;
      const next = new Set(discontinuedVendors);
      next.add(key);
      vendorSettingsMutation.mutate(buildSettingsUpdate({ discontinuedVendors: [...next] }));
    }
  }

  function handleContactedToggle(key: string, checked: boolean) {
    const next = new Set(contactedVendors);
    if (checked) next.add(key); else next.delete(key);
    vendorSettingsMutation.mutate(buildSettingsUpdate({ contactedVendors: [...next] }));
  }

  function handleContactNoteChange(key: string, note: string) {
    const next = { ...contactNotes, [key]: note };
    if (!note.trim()) delete next[key];
    vendorSettingsMutation.mutate(buildSettingsUpdate({ contactNotes: next }));
  }

  function saveVendorCard(vendorId: number) {
    const next = { ...vendorOverrides, [vendorId]: vendorCardDraft };
    vendorSettingsMutation.mutate(buildSettingsUpdate({
      vendorOverrides: Object.fromEntries(Object.entries(next).map(([k, v]) => [String(k), v])),
    }));
    setEditingVendorCard(null);
  }
  function resetVendorCard(vendorId: number) {
    const next = { ...vendorOverrides };
    delete next[vendorId];
    vendorSettingsMutation.mutate(buildSettingsUpdate({
      vendorOverrides: Object.fromEntries(Object.entries(next).map(([k, v]) => [String(k), v])),
    }));
    setEditingVendorCard(null);
  }

  // Which vendor's "add" form is open
  const [editingContactsFor, setEditingContactsFor] = useState<number | null>(null);
  // Draft for new contact
  const [contactDraft, setContactDraft] = useState<Omit<VendorContact, 'id'>>({ name: '', title: '', phone: '', email: '' });
  // Which contact is being edited inline: { vendorId, contactId }
  const [inlineEdit, setInlineEdit] = useState<{ vendorId: number; contactId: string } | null>(null);
  const [inlineEditDraft, setInlineEditDraft] = useState<Omit<VendorContact, 'id'>>({ name: '', title: '', phone: '', email: '' });

  function addCustomContact(vendorId: number) {
    const { name, title, phone, email } = contactDraft;
    if (!name?.trim() && !phone?.trim() && !email?.trim() && !title?.trim()) return;
    const contact: VendorContact = {
      id: crypto.randomUUID(),
      name: name?.trim() || undefined,
      title: title?.trim() || undefined,
      phone: phone?.trim() || undefined,
      email: email?.trim() || undefined,
    };
    const existing = customContacts[vendorId] ?? [];
    const next = { ...customContacts, [vendorId]: [...existing, contact] };
    vendorSettingsMutation.mutate(buildSettingsUpdate({
      customContacts: Object.fromEntries(Object.entries(next).map(([k, v]) => [String(k), v])),
    }));
    setContactDraft({ name: '', title: '', phone: '', email: '' });
    setEditingContactsFor(null);
  }

  function saveInlineEdit(vendorId: number, contactId: string) {
    const { name, title, phone, email } = inlineEditDraft;
    const updated: VendorContact = {
      id: contactId,
      name: name?.trim() || undefined,
      title: title?.trim() || undefined,
      phone: phone?.trim() || undefined,
      email: email?.trim() || undefined,
    };
    const existing = customContacts[vendorId] ?? [];
    const next = { ...customContacts, [vendorId]: existing.map((c) => c.id === contactId ? updated : c) };
    vendorSettingsMutation.mutate(buildSettingsUpdate({
      customContacts: Object.fromEntries(Object.entries(next).map(([k, v]) => [String(k), v])),
    }));
    setInlineEdit(null);
  }

  function removeCustomContact(vendorId: number, contactId: string) {
    const existing = customContacts[vendorId] ?? [];
    const next = { ...customContacts, [vendorId]: existing.filter((c) => c.id !== contactId) };
    vendorSettingsMutation.mutate(buildSettingsUpdate({
      customContacts: Object.fromEntries(Object.entries(next).map(([k, v]) => [String(k), v])),
    }));
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'overview', label: 'Overview', icon: TrendingUp },
    { id: 'purchasing', label: 'Purchasing', icon: ShoppingBag },
    { id: 'inventory', label: 'Inventory', icon: Package },
    { id: 'vendors', label: 'Vendors', icon: Users },
    { id: 'analytics', label: 'Trends', icon: BarChart3Icon },
    { id: 'insights', label: 'Performance', icon: LightbulbIcon },
    { id: 'staff', label: 'Staff', icon: Users },
    ...(showReportingTab ? [{ id: 'reporting' as const, label: 'Reporting', icon: BarChart3Icon }] : []),
  ];

  function refetchCurrent() {
    if (tab === 'overview') void dashQ.refetch();
    if (tab === 'analytics') void analyticsQ.refetch();
    if (tab === 'inventory') void inventoryQ.refetch();
    if (tab === 'staff') void staffQ.refetch();
    if (tab === 'purchasing') void purchasingQ.refetch();
    if (tab === 'vendors') void purchasingQ.refetch();
    if (tab === 'reporting') void reportingQ.refetch();
    if (tab === 'insights') {
      void reportingQ.refetch();
      void insightsQ.refetch();
    }
  }

  const isFetching = dashQ.isFetching || analyticsQ.isFetching || inventoryQ.isFetching || staffQ.isFetching || purchasingQ.isFetching || reportingQ.isFetching || insightsQ.isFetching;

  // Daily/monthly revenue goals — persisted in localStorage
  const GOALS_KEY = 'foot-solutions:revenue-goals';
  const [goals, setGoals] = useState<{ daily: number; monthly: number }>(() => {
    try {
      const saved = window.localStorage.getItem(GOALS_KEY);
      return saved ? JSON.parse(saved) : { daily: 2000, monthly: 50000 };
    } catch {
      return { daily: 2000, monthly: 50000 };
    }
  });
  const [editingGoals, setEditingGoals] = useState(false);
  const [goalDraft, setGoalDraft] = useState(goals);

  // For the per-vendor open orders popup on the Purchasing tab
  const [orderModalVendor, setOrderModalVendor] = useState<{ id: number; name: string } | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [orderLinesCache, setOrderLinesCache] = useState<Record<number, { lines: OrderLine[]; error?: string }>>({});

  // For the low-stock contact popup on the Inventory tab
  const [lowStockContactBrand, setLowStockContactBrand] = useState<string | null>(null);

  async function loadOrderLines(orderId: number) {
    try {
      const r = await api.get<{ orderId: number; lineCount: number; lines: OrderLine[] }>(`/pos/purchasing/orders/${orderId}/lines`);
      setOrderLinesCache((prev) => ({ ...prev, [orderId]: { lines: r.data.lines } }));
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
        ?? (err as Error).message;
      setOrderLinesCache((prev) => ({ ...prev, [orderId]: { lines: [], error: msg } }));
    }
  }

  function saveGoals() {
    setGoals(goalDraft);
    try { window.localStorage.setItem(GOALS_KEY, JSON.stringify(goalDraft)); } catch { /* ignore */ }
    setEditingGoals(false);
  }

  // ── Per-tab CSV export ──────────────────────────────────────────────
  // Each tab has a "Download" button that emits a structured, multi-section
  // CSV (UTF-8 BOM, opens cleanly in Excel/Sheets/Numbers). The sections are
  // titled and headed for readability so it can be forwarded to management.

  function buildOverviewExport(): CsvSection[] | null {
    if (!dashQ.data) return null;
    const d = dashQ.data;
    return [
      {
        title: 'Foot Solutions — Sales Overview',
        subtitle: `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · Last sync ${d.syncInfo?.lastSyncAt ? new Date(d.syncInfo.lastSyncAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'never'}`,
        headers: ['Period', 'Gross Sales (USD)', 'Transactions'],
        rows: [
          ['Today', csvNum(d.today.totalAmount), d.today.ticketCount],
          ['Last 7 Days', csvNum(d.last7Days.totalAmount), d.last7Days.ticketCount],
          ['Last 30 Days', csvNum(d.last30Days.totalAmount), d.last30Days.ticketCount],
          ['Year to Date', csvNum(d.yearToDate.totalAmount), d.yearToDate.ticketCount],
        ],
      },
      {
        title: 'Revenue Goals',
        headers: ['Goal Period', 'Target (USD)', 'Actual (USD)', 'Progress %'],
        rows: [
          [
            'Daily',
            csvNum(goals.daily),
            csvNum(d.today.totalAmount),
            csvNum(goals.daily > 0 ? (d.today.totalAmount / goals.daily) * 100 : 0, 1),
          ],
          [
            'Monthly (last 30d)',
            csvNum(goals.monthly),
            csvNum(d.last30Days.totalAmount),
            csvNum(goals.monthly > 0 ? (d.last30Days.totalAmount / goals.monthly) * 100 : 0, 1),
          ],
        ],
      },
      {
        title: 'Notes',
        rows: [
          ['Sales include 8.25% Denton sales tax (gross). For tax-ready net revenue, see Reporting tab.'],
        ],
      },
    ];
  }

  function buildAnalyticsExport(): CsvSection[] | null {
    if (!analyticsQ.data) return null;
    const d = analyticsQ.data;
    return [
      {
        title: `Foot Solutions — Sales Analytics (last ${d.days} day${d.days === 1 ? '' : 's'})`,
        subtitle: `${d.fromDate} to ${d.toDate} · Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Revenue (USD)', csvNum(d.summary.totalAmount)],
          ['Total Transactions', d.summary.totalCount],
          ['Average Ticket (USD)', csvNum(d.summary.avgTicket)],
          ['Total Discounts (USD)', csvNum(d.discountSummary.totalDiscounts)],
          ['Discount Rate %', csvNum(d.discountSummary.discountRate, 2)],
          ['Avg Discount per Ticket (USD)', csvNum(d.discountSummary.avgDiscountPerTicket)],
        ],
      },
      {
        title: 'Daily Trend',
        headers: ['Date', 'Revenue (USD)', 'Transactions'],
        rows: d.dailyTrend.map((r) => [r.date, csvNum(r.amount), r.count]),
      },
      {
        title: 'Payment Methods',
        headers: ['Method', 'Amount (USD)', 'Transactions', '% of Total'],
        rows: d.paymentMethods.map((p) => [p.name, csvNum(p.amount), p.count, csvNum(p.pct, 2)]),
      },
      {
        title: 'Hourly Heatmap',
        headers: ['Hour', 'Revenue (USD)'],
        rows: d.hourlyHeatmap.map((h) => [h.label, csvNum(h.amount)]),
      },
      {
        title: 'Top Customers',
        headers: ['Customer', 'Revenue (USD)', 'Visits'],
        rows: d.topCustomers.map((c) => [c.name, csvNum(c.amount), c.visits]),
      },
      {
        title: 'Sales by Rep',
        headers: ['Rep', 'Revenue (USD)', 'Transactions'],
        rows: d.bySalesRep.map((r) => [r.name, csvNum(r.amount), r.count]),
      },
    ];
  }

  function buildInventoryExport(): CsvSection[] | null {
    if (!inventoryQ.data || inventoryQ.data.notReady) return null;
    const d = inventoryQ.data;
    return [
      {
        title: 'Foot Solutions — Inventory Snapshot',
        subtitle: `Last synced ${d.cachedAt ? new Date(d.cachedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'never'} · Location 100006 (Flower Mound, TX)`,
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Items', d.summary.totalItems],
          ['Active Items', d.summary.activeItems],
          ['Live Catalog (active + cost+price set)', d.summary.liveItems ?? d.summary.itemsWithCostData],
          ['Avg Gross Margin %', csvNum(d.summary.overallAvgMarginPct, 2)],
          ['Total Qty on Hand', d.summary.totalQtyOnHand ?? ''],
        ],
      },
      {
        title: 'By Department',
        headers: ['Department', 'Item Count', 'Avg Margin %', 'Total Cost (USD)', 'Total Price (USD)', 'Total Qty'],
        rows: d.byDepartment.map((r) => [r.name, r.count, csvNum(r.avgMargin, 2), csvNum(r.totalCost), csvNum(r.totalPrice), r.totalQty ?? '']),
      },
      {
        title: 'By Brand',
        headers: ['Brand', 'Item Count', 'Total Revenue (USD)', 'Total Qty'],
        rows: d.byBrand.map((r) => [r.name, r.count, csvNum(r.totalRevenue ?? 0), r.totalQty ?? '']),
      },
      {
        title: 'Top Margin Items',
        headers: ['SKU', 'Description', 'Brand', 'Department', 'Cost (USD)', 'Price (USD)', 'Margin %', 'Qty on Hand'],
        rows: d.topMarginItems.map((i) => [i.sku, i.description, i.brand, i.department, csvNum(i.cost), csvNum(i.price), csvNum(i.margin, 2), i.qty_on_hand ?? '']),
      },
      {
        title: 'Low Margin Items (<20%)',
        headers: ['SKU', 'Description', 'Cost (USD)', 'Price (USD)', 'Margin %', 'Qty on Hand'],
        rows: d.lowMarginItems.map((i) => [i.sku, i.description, csvNum(i.cost), csvNum(i.price), csvNum(i.margin, 2), i.qty_on_hand ?? '']),
      },
      {
        title: 'Low Stock (≤3 units)',
        headers: ['SKU', 'Description', 'Brand', 'Department', 'On Hand', 'Available', 'Price (USD)'],
        rows: (d.lowStockItems ?? []).map((i) => [i.sku, i.description, i.brand, i.department, i.qty_on_hand, i.qty_available, csvNum(i.price)]),
      },
    ];
  }

  function buildStaffExport(): CsvSection[] | null {
    if (!staffQ.data) return null;
    const d = staffQ.data;
    const periodLabel = d.label ?? (d.year ? `${d.year} Year-to-Date` : 'Year to date');
    const rangeText = d.fromDate && d.toDate ? ` · ${d.fromDate} to ${d.toDate}` : '';
    return [
      {
        title: 'Foot Solutions — Staff Performance',
        subtitle: `${periodLabel}${rangeText} · ${d.totalUsers} users · As of ${new Date(d.asOf).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
        headers: ['Rank', 'Name', 'Revenue (USD)', 'Active Days', 'Avg per Day (USD)'],
        rows: d.staff.map((s, i) => [i + 1, s.name, csvNum(s.amount ?? s.ytdAmount ?? 0), s.activeDays, csvNum(s.avgPerDay)]),
      },
    ];
  }

  function buildPurchasingExport(): CsvSection[] | null {
    if (!purchasingQ.data || purchasingQ.data.notReady) return null;
    const d = purchasingQ.data;
    const brandSales: Record<string, number> = {};
    if (reportingQ.data?.brandRows) {
      for (const r of reportingQ.data.brandRows) {
        const b = r['item.custom@brand'] as string | undefined;
        const s = (r['source_sales.net_sales'] as number) ?? 0;
        if (b) brandSales[b.toUpperCase()] = s;
      }
    }
    const rankMap: Record<number, { open: number; total: number; received: number }> = {};
    for (const r of d.vendorRank ?? []) {
      rankMap[r.vendorId] = {
        open: r.openOrders ?? 0,
        total: r.totalOrders ?? 0,
        received: r.totalReceivedQty,
      };
    }
    const vendorRows = [...d.vendors]
      .filter((v) => {
        const n = (v.name ?? '').toLowerCase();
        return !n.includes('foot solutions inc') && !n.includes('fs corp');
      })
      .sort((a, b) => {
        const sa = brandSales[(a.name ?? '').toUpperCase()] ?? rankMap[a.id]?.received ?? 0;
        const sb = brandSales[(b.name ?? '').toUpperCase()] ?? rankMap[b.id]?.received ?? 0;
        return sb - sa;
      })
      .map((v) => {
        const info = VENDOR_CONTACTS[v.name?.toUpperCase() ?? ''] ?? VENDOR_CONTACTS[v.name ?? ''];
        const r = rankMap[v.id];
        const ytd = brandSales[(v.name ?? '').toUpperCase()] ?? 0;
        const accountKey = `vendor-account:${v.id}`;
        return [
          v.name ?? `Vendor ${v.id}`,
          csvNum(ytd),
          r?.open ?? 0,
          r?.total ?? 0,
          info?.phone ?? '',
          info?.email ?? '',
          info?.website ?? '',
          info?.rep?.name ?? '',
          info?.rep?.phone ?? '',
          info?.rep?.email ?? '',
          info?.rep?.account ?? '',
          activeAccounts.has(accountKey) ? 'Yes' : 'No',
          discontinuedVendors.has(accountKey) ? 'Yes' : 'No',
        ];
      });
    return [
      {
        title: 'Foot Solutions — Vendor Directory & Open Orders',
        subtitle: `Last synced ${d.cachedAt ? new Date(d.cachedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'never'}`,
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Vendors', d.vendorCount],
          ['Total Orders', d.totalOrders],
          ['Open Orders', d.openOrderCount],
        ],
      },
      {
        title: 'Vendors (sorted by YTD net sales)',
        headers: [
          'Vendor', 'YTD Net Sales (USD)', 'Open Orders', 'Total Orders',
          'Phone', 'Email', 'Website', 'Rep Name', 'Rep Phone', 'Rep Email', 'Account #',
          'Active Account?', 'Discontinuing?',
        ],
        rows: vendorRows,
      },
      {
        title: 'Open / Pending Orders',
        headers: ['PO #', 'Vendor', 'Status', 'Created', 'Days Open', 'Qty Ordered', 'Qty Open', 'Qty Received', 'Cost (USD)'],
        rows: d.orders
          .slice()
          .sort((a, b) => {
            const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
            return tb - ta;
          })
          .map((o) => {
            const created = o.created_at ? new Date(o.created_at) : null;
            const days = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : '';
            const ordered = o.total_qty ?? 0;
            const open = o.total_open_qty ?? 0;
            return [
              String(o.public_id ?? o.id),
              o.vendorName ?? '',
              o.status ?? '',
              created ? created.toLocaleDateString('en-US', { timeZone: 'America/Chicago' }) : '',
              days,
              ordered,
              open,
              ordered - open,
              csvNum(o.total_cost ?? 0),
            ];
          }),
      },
    ];
  }

  function buildReportingExport(): CsvSection[] | null {
    if (!reportingQ.data || reportingQ.data.notReady) return null;
    const d = reportingQ.data;
    return [
      {
        title: 'Foot Solutions — Reporting (Heartland Analyzer)',
        subtitle: `${d.fromDate} to ${d.toDate} · Last synced ${d.cachedAt ? new Date(d.cachedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'never'}`,
        headers: ['Metric', 'Value'],
        rows: [
          ['YTD Net Sales (USD)', csvNum(d.summary.totalNetSales)],
          ['YTD Transactions', d.summary.totalTransactions],
          ['YTD Net Margin (USD)', d.summary.totalNetMargin != null ? csvNum(d.summary.totalNetMargin) : 'not available'],
          ['Avg Net Margin %', d.summary.avgNetMarginPct != null ? csvNum(d.summary.avgNetMarginPct, 2) : 'not available'],
          ['Last 30d Net Sales (USD)', csvNum(d.summary.last30Days?.netSales ?? 0)],
          ['Last 30d Transactions', d.summary.last30Days?.transactions ?? 0],
        ],
      },
      {
        title: 'Daily Net Sales (last 30 days)',
        headers: ['Date', 'Net Sales (USD)', 'Transactions', 'Avg Ticket (USD)'],
        rows: d.dailyRows.map((r) => {
          const sales = (r['source_sales.net_sales'] as number) ?? 0;
          const tx = (r['source_sales.transaction_count'] as number) ?? 0;
          return [
            String(r['date.date'] ?? ''),
            csvNum(sales),
            tx,
            csvNum(tx > 0 ? sales / tx : 0),
          ];
        }),
      },
      {
        title: 'Top Brands (YTD)',
        headers: ['Brand', 'Net Sales (USD)', 'Net Qty Sold', 'Net Margin (USD)', 'Transactions', 'Variants Merged'],
        rows: d.brandRows
          .filter((r) => ((r['source_sales.net_sales'] as number) ?? 0) > 0)
          .map((r) => [
            String(r['item.custom@brand'] ?? '(brand not set)'),
            csvNum((r['source_sales.net_sales'] as number) ?? 0),
            (r['source_sales.net_qty_sold'] as number) ?? 0,
            csvNum((r['source_sales.net_margin'] as number) ?? 0),
            (r['source_sales.transaction_count'] as number) ?? 0,
            r.variantCount ?? 1,
          ]),
      },
    ];
  }

  function buildInsightsExport(): CsvSection[] | null {
    const usingPrior = insightsYear !== currentYearStr;
    const d = usingPrior
      ? (insightsQ.data as unknown as ReportingResponse & InsightsResponse | undefined)
      : (reportingQ.data as unknown as ReportingResponse & InsightsResponse | undefined);
    if (!d || d.notReady) return null;
    const ci = d.customerInsights;
    const sections: CsvSection[] = [
      {
        title: `Foot Solutions — Insights (${insightsYear === 'all' ? 'all available years' : insightsYear})`,
        subtitle: `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
        rows: [],
      },
    ];
    if (ci) {
      sections.push({
        title: 'Customer Retention (YTD)',
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Customers', ci.totalCustomers],
          ['Repeat Buyers', ci.repeatCustomers],
          ['New Customers', ci.newCustomers],
          ['Repeat Rate %', csvNum(ci.repeatRate, 2)],
          ['Repeat Revenue (USD)', csvNum(ci.repeatRevenue)],
          ['Repeat Revenue % of Total', csvNum(ci.repeatRevenuePct, 2)],
        ],
      });
    }
    const returnRows = (d.returnRows ?? [])
      .filter((r) => ((r['source_sales.gross_sales'] as number) ?? 0) > 0)
      .map((r) => {
        const gross = (r['source_sales.gross_sales'] as number) ?? 0;
        const returns = Math.abs((r['source_sales.gross_returns'] as number) ?? 0);
        const rate = gross > 0 ? (returns / gross) * 100 : 0;
        return [
          String(r['item.custom@brand'] ?? 'Unknown'),
          csvNum(gross),
          csvNum(returns),
          csvNum(rate, 2),
        ];
      })
      .sort((a, b) => Number(b[3]) - Number(a[3]));
    if (returnRows.length) {
      sections.push({
        title: 'Return Rate by Brand (YTD)',
        headers: ['Brand', 'Gross Sales (USD)', 'Gross Returns (USD)', 'Return Rate %'],
        rows: returnRows,
      });
    }
    const lowStock = !usingPrior ? (inventoryQ.data?.lowStockItems ?? []) : [];
    if (lowStock.length) {
      sections.push({
        title: 'Reorder Alerts (≤3 units on hand)',
        headers: ['SKU', 'Description', 'Brand', 'On Hand', 'Available', 'Price (USD)', 'Vendor Phone'],
        rows: lowStock.map((i) => {
          const info = VENDOR_CONTACTS[i.brand?.toUpperCase() ?? ''] ?? VENDOR_CONTACTS[i.brand ?? ''];
          return [i.sku, i.description, i.brand, i.qty_on_hand, i.qty_available, csvNum(i.price), info?.phone ?? ''];
        }),
      });
    }
    return sections;
  }

  function downloadCurrentTab() {
    let sections: CsvSection[] | null = null;
    let slug = '';
    switch (tab) {
      case 'overview':   sections = buildOverviewExport();   slug = 'salesrev_overview'; break;
      case 'analytics':  sections = buildAnalyticsExport();  slug = `salesrev_analytics_${analyticsDays}d`; break;
      case 'inventory':  sections = buildInventoryExport();  slug = 'salesrev_inventory'; break;
      case 'staff':      sections = buildStaffExport();      slug = 'salesrev_staff'; break;
      case 'purchasing': sections = buildPurchasingExport(); slug = 'salesrev_purchasing'; break;
      case 'reporting':  sections = buildReportingExport();  slug = 'salesrev_reporting'; break;
      case 'insights':   sections = buildInsightsExport();   slug = `salesrev_insights_${insightsYear}`; break;
    }
    if (!sections) return;
    downloadCsvSections(stampedName(slug), sections);
  }

  // Disable Download when the active tab has no data loaded yet
  const downloadDisabled = (() => {
    switch (tab) {
      case 'overview':   return !dashQ.data;
      case 'analytics':  return !analyticsQ.data;
      case 'inventory':  return !inventoryQ.data || !!inventoryQ.data.notReady;
      case 'staff':      return !staffQ.data;
      case 'purchasing': return !purchasingQ.data || !!purchasingQ.data.notReady;
      case 'reporting':  return !reportingQ.data || !!reportingQ.data.notReady;
      case 'insights': {
        const usingPrior = insightsYear !== currentYearStr;
        const d = usingPrior ? insightsQ.data : reportingQ.data;
        return !d || !!(d as { notReady?: boolean } | undefined)?.notReady;
      }
      default:           return true;
    }
  })();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">          <Link to="/" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">Sales & Revenue</h1>
          <CentralTimeBadge />
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
            <button
              onClick={downloadCurrentTab}
              disabled={downloadDisabled}
              title={downloadDisabled ? 'Load this tab first' : 'Download a CSV/Excel-friendly export of this tab'}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <Download className="w-3.5 h-3.5" />
              Download
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
            {/* ── Date filter bar (compact, top of tab) ── */}
            <div className="bg-white rounded-xl border border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                  Dates
                </span>
                <div className="relative">
                  <select
                    value={datePreset}
                    onChange={(e) => applyPreset(e.target.value as DatePreset)}
                    aria-label="Date preset"
                    className="appearance-none rounded-md border border-slate-300 bg-white pl-2 pr-6 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                  >
                    {(Object.keys(PRESET_LABELS) as DatePreset[]).map((p) => (
                      <option key={p} value={p}>{PRESET_LABELS[p]}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">▾</span>
                </div>
                <input
                  type="date"
                  value={filterStart}
                  onChange={(e) => { setFilterStart(e.target.value); setDatePreset('custom'); }}
                  aria-label="Start date"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-slate-400 text-xs">–</span>
                <input
                  type="date"
                  value={filterEnd}
                  onChange={(e) => { setFilterEnd(e.target.value); setDatePreset('custom'); }}
                  aria-label="End date"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {filterStart && filterEnd && (
                  <span className="text-[11px] text-slate-400 hidden sm:inline">
                    {new Date(filterStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {' – '}
                    {new Date(filterEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}

                {/* ── Beat Last Year widget — compact, right-aligned ── */}
                {dashQ.data?.lastYear && (() => {
                  const lyAmount = dashQ.data.lastYear!.selectedRange?.totalAmount
                    ?? dashQ.data.lastYear!.today.totalAmount;
                  const currentAmount = dashQ.data.selectedRange?.totalAmount
                    ?? dashQ.data.today.totalAmount;
                  const toBeat = lyAmount - currentAmount;
                  const alreadyBeaten = toBeat <= 0;
                  const lyDate = filterStart
                    ? new Date(filterStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : 'same day';
                  return (
                    <div className={`ml-auto flex items-center gap-2 rounded-md px-2.5 py-1 border ${alreadyBeaten ? 'bg-emerald-50 border-emerald-200' : 'bg-blue-50 border-blue-200'}`}>
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 leading-tight">
                        {alreadyBeaten ? '🏆 Beat LY' : `To beat LY · ${lyDate}`}
                      </span>
                      <span
                        className={`text-sm font-bold leading-tight ${alreadyBeaten ? 'text-emerald-600' : 'text-blue-700'}`}
                        title={`LY: ${fmtDec(lyAmount)} · Now: ${fmtDec(currentAmount)}`}
                      >
                        {alreadyBeaten ? `+${fmtDec(Math.abs(toBeat))} ahead` : `${fmtDec(toBeat)} needed`}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* ── KPI metric cards (vs last year) — moved to top per owner request ── */}
            {dashQ.isLoading && <LoadingState label="Loading sales data from Heartland…" />}
            {dashQ.isError && <ErrorState error={dashQ.error} />}
            {dashQ.data && (
              <KpiGrid data={dashQ.data} reportingData={reportingQ.data ?? null} filterStart={filterStart} filterEnd={filterEnd} />
            )}

            <DailyHighlightsCard />

            {dashQ.data && (
              <>
                {/* ── Alerts + Notes row ── */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
                  {/* Alerts */}
                  <AlertsPanel alerts={dashQ.data.alerts} onNavigate={setTab} />
                  {/* Notes */}
                  <div className="min-w-0 overflow-hidden">
                    <NotesPanel />
                  </div>
                </div>

                {/* ── Inventory Turn Rate — compact overview card ── */}
                {inventoryQ.data && !inventoryQ.data.notReady && (() => {
                  const invTurn = (() => {
                    const totalCost = (inventoryQ.data?.byDepartment ?? []).reduce((s, d) => s + d.totalCost, 0);
                    const ytdNet = reportingQ.data?.summary?.totalNetSales ?? dashQ.data.yearToDate.totalAmount;
                    return totalCost > 0 ? Math.round((ytdNet / totalCost) * 10) / 10 : null;
                  })();
                  if (invTurn === null) return null;
                  const color = invTurn >= 3 ? 'text-emerald-600' : invTurn >= 2 ? 'text-amber-600' : 'text-red-600';
                  const bg = invTurn >= 3 ? 'bg-emerald-50 border-emerald-200' : invTurn >= 2 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
                  return (
                    <div className={`rounded-xl border px-5 py-3 flex items-center gap-4 ${bg}`}>
                      <Package className="w-5 h-5 text-slate-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Inventory Turn Rate</p>
                          <BenchmarkTip lines={[
                            'Specialty footwear benchmark: 2–4× per year.',
                            '< 2× — slow-moving stock, consider markdowns.',
                            '2–3× — moderate, monitor clearance candidates.',
                            '≥ 3× — healthy, inventory moving well.',
                            'Calculated as YTD net sales ÷ inventory cost value.',
                          ]} />
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {invTurn >= 3 ? '✓ Healthy — inventory is moving well.' : invTurn >= 2 ? '⚠ Moderate — some slow-moving stock.' : '⚠ Low — significant capital tied up in slow inventory.'}
                        </p>
                      </div>
                      <p className={`text-3xl font-bold flex-shrink-0 ${color}`}>{invTurn}×</p>
                    </div>
                  );
                })()}

                {/* ── Two-column: Net Sales by Hour + Top Performers ── */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <NetSalesByHourChart hourly={dashQ.data.hourly} dailyTrend={analyticsQ.data?.dailyTrend} />
                  <TopPerformersPanel reportingData={reportingQ.data ?? null} analyticsData={analyticsQ.data ?? null} />
                </div>

                {/* ── Revenue goal tracker ── */}
                <div className="bg-white rounded-lg border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Revenue Goals</h3>
                    {editingGoals ? (
                      <div className="flex items-center gap-2">
                        <button onClick={saveGoals} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Save</button>
                        <button onClick={() => { setEditingGoals(false); setGoalDraft(goals); }} className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingGoals(true); setGoalDraft(goals); }} className="text-xs text-slate-400 hover:text-slate-700">Edit goals</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Daily goal */}
                    {(() => {
                      const actual = dashQ.data.today.totalAmount;
                      const pct = Math.min(100, goals.daily > 0 ? Math.round((actual / goals.daily) * 100) : 0);
                      const onPace = actual >= goals.daily;
                      const hoursElapsed = new Date().getHours() + new Date().getMinutes() / 60;
                      const pacedTarget = goals.daily * (hoursElapsed / 10);
                      const pacing = actual >= pacedTarget ? 'on-pace' : 'behind';
                      return (
                        <div>
                          <div className="flex items-baseline justify-between mb-1">
                            <span className="text-xs font-medium text-slate-600">Today</span>
                            {editingGoals ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-slate-400">$</span>
                                <input type="number" value={goalDraft.daily} onChange={(e) => setGoalDraft((g) => ({ ...g, daily: Number(e.target.value) }))} className="w-24 text-xs border border-slate-300 rounded px-2 py-0.5 text-right" />
                              </div>
                            ) : (
                              <span className="text-xs text-slate-500">{fmt(actual)} / {fmt(goals.daily)}</span>
                            )}
                          </div>
                          <div className="w-full bg-slate-100 rounded-full h-3">
                            <div className={`h-3 rounded-full transition-all ${onPace ? 'bg-emerald-500' : pacing === 'on-pace' ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className={`text-[11px] font-medium ${onPace ? 'text-emerald-600' : pacing === 'on-pace' ? 'text-blue-600' : 'text-amber-600'}`}>
                              {onPace ? '✓ Goal reached' : pacing === 'on-pace' ? '↑ On pace' : '↓ Behind pace'}
                            </span>
                            <span className="text-[11px] text-slate-400">{pct}%</span>
                          </div>
                        </div>
                      );
                    })()}
                    {/* Monthly goal */}
                    {(() => {
                      const actual = dashQ.data.last30Days.totalAmount;
                      const pct = Math.min(100, goals.monthly > 0 ? Math.round((actual / goals.monthly) * 100) : 0);
                      const onPace = actual >= goals.monthly;
                      const dayOfMonth = new Date().getDate();
                      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
                      const pacedTarget = goals.monthly * (dayOfMonth / daysInMonth);
                      const pacing = actual >= pacedTarget ? 'on-pace' : 'behind';
                      return (
                        <div>
                          <div className="flex items-baseline justify-between mb-1">
                            <span className="text-xs font-medium text-slate-600">Last 30 Days</span>
                            {editingGoals ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-slate-400">$</span>
                                <input type="number" value={goalDraft.monthly} onChange={(e) => setGoalDraft((g) => ({ ...g, monthly: Number(e.target.value) }))} className="w-28 text-xs border border-slate-300 rounded px-2 py-0.5 text-right" />
                              </div>
                            ) : (
                              <span className="text-xs text-slate-500">{fmt(actual)} / {fmt(goals.monthly)}</span>
                            )}
                          </div>
                          <div className="w-full bg-slate-100 rounded-full h-3">
                            <div className={`h-3 rounded-full transition-all ${onPace ? 'bg-emerald-500' : pacing === 'on-pace' ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className={`text-[11px] font-medium ${onPace ? 'text-emerald-600' : pacing === 'on-pace' ? 'text-blue-600' : 'text-amber-600'}`}>
                              {onPace ? '✓ Goal reached' : pacing === 'on-pace' ? '↑ On pace' : '↓ Behind pace'}
                            </span>
                            <span className="text-[11px] text-slate-400">{pct}%</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
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
                    {showTotalRevenueCard && (
                      <StatCard label="Total Revenue" value={fmt(d.summary.totalAmount)} sub={`${d.summary.totalCount.toLocaleString()} transactions`} icon={TrendingUp} color="blue" />
                    )}
                    {showAvgTicketCard && (
                      <StatCard label="Avg Ticket" value={fmtDec(d.summary.avgTicket)} sub="per transaction" icon={ShoppingBag} color="green" />
                    )}
                    <StatCard label="Total Discounts" value={fmt(d.discountSummary.totalDiscounts)} sub={`${fmtPct(d.discountSummary.discountRate)} discount rate`} icon={Tag} color="amber" />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Hourly heatmap */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-slate-400" /> Peak Hours
                      </h3>
                      <HourlyHeatmap data={d.hourlyHeatmap} />
                      <p className="text-xs text-slate-400 mt-3">Darker = more revenue. Based on local store time.</p>
                    </div>

                    {/* Payment Methods card moved to the Purchasing tab */}
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

                  {/* Daily trend — bottom of page */}
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-1">Daily Revenue Trend</h3>
                    <p className="text-xs text-slate-500 mb-4">{fmtDate(d.fromDate)} – {fmtDate(d.toDate)} · Hover any point for details. All times Central.</p>
                    <LineChart
                      data={d.dailyTrend.map((r) => ({
                        date: r.date,
                        amount: r.amount,
                        meta: { transactions: r.count },
                      }))}
                      height={d.dailyTrend.length <= 7 ? 240 : 280}
                      yLabel="Revenue ($)"
                      xLabel="Date"
                      tooltipExtra={(p) => {
                        const txn = (p.meta?.transactions as number) ?? 0;
                        if (!txn) return null;
                        const avg = p.amount / txn;
                        return `${txn.toLocaleString()} ticket${txn === 1 ? '' : 's'} · avg $${avg.toFixed(2)}`;
                      }}
                    />
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
                    <div className="bg-white rounded-lg border border-slate-200 p-5 flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <TrendingUp className="w-4 h-4 text-purple-500" />
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Avg Gross Margin</p>
                        <BenchmarkTip lines={[
                          'Specialty footwear benchmark: 45–55% gross margin.',
                          '< 40% — below industry average, review pricing or COGS.',
                          '40–50% — typical for independent footwear retailers.',
                          '> 50% — strong margin, good pricing power.',
                          'Calculated as (price − cost) ÷ price across all live SKUs.',
                        ]} />
                      </div>
                      <p className="text-2xl font-bold text-slate-900">{fmtPct(d.summary.overallAvgMarginPct)}</p>
                      <p className="text-xs text-slate-400">across live items</p>
                    </div>
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Last Synced</p>
                      <p className="text-sm font-medium text-slate-700 mt-1">{relativeTime(d.cachedAt)}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{d.cachedAt ? new Date(d.cachedAt).toLocaleString() : '—'}</p>
                    </div>
                  </div>

                  {/* Low stock items — moved to second row for visibility */}
                  {d.lowStockItems && d.lowStockItems.length > 0 && (() => {
                    const items = d.lowStockItems!;
                    const allBrands = [...new Set(items.map((i) => i.brand).filter(Boolean))].sort();
                    const filtered = stockBrandFilter
                      ? items.filter((i) => i.brand === stockBrandFilter)
                      : items;

                    function baseStyle(desc: string): string {
                      return desc.replace(/\s*[-–]\s*\d+(\.\d+)?$/, '').trim();
                    }
                    type StockItem = typeof items[0];
                    const groups = new Map<string, { base: string; brand: string; price: number; items: StockItem[] }>();
                    for (const item of filtered) {
                      const base = baseStyle(item.description);
                      const key = `${item.brand}||${base}`;
                      if (!groups.has(key)) groups.set(key, { base, brand: item.brand, price: item.price, items: [] });
                      groups.get(key)!.items.push(item);
                    }
                    const groupList = [...groups.values()].sort((a, b) => {
                      const minA = Math.min(...a.items.map((i) => i.qty_on_hand));
                      const minB = Math.min(...b.items.map((i) => i.qty_on_hand));
                      if (minA !== minB) return minA - minB;
                      return a.brand.localeCompare(b.brand);
                    });

                    return (
                      <div className="bg-white rounded-lg border border-red-200 p-5">
                        <div className="flex items-start justify-between gap-4 mb-1">
                          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                            <Package className="w-4 h-4 text-red-500" /> Low Stock Alert (≤3 units)
                          </h3>
                          <span className="text-xs text-slate-400 flex-shrink-0">
                            {groupList.length} styles · {filtered.length} SKUs · {allBrands.length} brands
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mb-3">Items at Flower Mound with 3 or fewer units on hand. Grouped by style — click a row to see vendor contact info.</p>

                        <div className="flex items-center gap-2 mb-4 flex-wrap">
                          <span className="text-xs text-slate-500 flex-shrink-0">Brand:</span>
                          <button onClick={() => setStockBrandFilter('')}
                            className={`text-xs px-2.5 py-1 rounded-full border transition ${!stockBrandFilter ? 'bg-red-500 text-white border-red-500' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                            All ({items.length})
                          </button>
                          {allBrands.map((b) => (
                            <button key={b} onClick={() => setStockBrandFilter(b === stockBrandFilter ? '' : b)}
                              className={`text-xs px-2.5 py-1 rounded-full border transition ${stockBrandFilter === b ? 'bg-red-500 text-white border-red-500' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                              {b} ({items.filter((i) => i.brand === b).length})
                            </button>
                          ))}
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-100">
                                <th className="text-left py-2 text-slate-500 font-medium">Style</th>
                                <th className="text-left py-2 text-slate-500 font-medium">Brand</th>
                                <th className="text-left py-2 text-slate-500 font-medium">Sizes on Hand</th>
                                <th className="text-right py-2 text-slate-500 font-medium">SKUs</th>
                                <th className="text-right py-2 text-slate-500 font-medium">Price</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {groupList.map((g) => {
                                const sizes = g.items
                                  .map((i) => {
                                    const m = i.description.match(/[-–]\s*(\d+(?:\.\d+)?)$/);
                                    return m ? m[1] : i.sku;
                                  })
                                  .sort((a, b) => parseFloat(a) - parseFloat(b));
                                const minQty = Math.min(...g.items.map((i) => i.qty_on_hand));
                                const key = `${g.brand}||${g.base}`;
                                return (
                                  <tr key={key} className="hover:bg-red-50 cursor-pointer transition-colors" onClick={() => setLowStockContactBrand(g.brand)}>
                                    <td className="py-2 text-slate-700 max-w-[260px]">
                                      <span className="font-medium">{g.base}</span>
                                    </td>
                                    <td className="py-2 text-blue-600 font-medium">{g.brand}</td>
                                    <td className="py-2">
                                      <div className="flex flex-wrap gap-1">
                                        {sizes.map((s, si) => {
                                          const item = g.items.find((i) => {
                                            const m = i.description.match(/[-–]\s*(\d+(?:\.\d+)?)$/);
                                            return (m ? m[1] : i.sku) === s;
                                          });
                                          const qty = item?.qty_on_hand ?? 1;
                                          return (
                                            <span key={si}
                                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${qty <= 1 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                              {s}
                                            </span>
                                          );
                                        })}
                                      </div>
                                    </td>
                                    <td className={`py-2 text-right font-semibold ${minQty <= 1 ? 'text-red-600' : 'text-amber-600'}`}>
                                      {g.items.length}
                                    </td>
                                    <td className="py-2 text-right text-slate-600">{fmtDec(g.price)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}

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
            {/* Period selector */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-600">Period:</span>
              {([
                { id: 'today', label: 'Today' },
                { id: '7d', label: '7d' },
                { id: '30d', label: '30d' },
                { id: 'monthly', label: 'Month to date' },
                { id: 'ytd', label: 'YTD' },
                { id: 'custom', label: 'Custom' },
              ] as Array<{ id: StaffPeriod; label: string }>).map((p) => (
                <button
                  key={p.id}
                  onClick={() => setStaffPeriod(p.id)}
                  className={`px-3 py-1 text-sm rounded-full border transition ${
                    staffPeriod === p.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              {staffPeriod === 'custom' && (
                <div className="flex items-center gap-2 ml-2">
                  <input
                    type="date"
                    value={staffCustomStart}
                    onChange={(e) => setStaffCustomStart(e.target.value)}
                    className="text-sm border border-slate-300 rounded px-2 py-1"
                    aria-label="Start date"
                  />
                  <span className="text-xs text-slate-500">to</span>
                  <input
                    type="date"
                    value={staffCustomEnd}
                    onChange={(e) => setStaffCustomEnd(e.target.value)}
                    className="text-sm border border-slate-300 rounded px-2 py-1"
                    aria-label="End date"
                  />
                </div>
              )}
              <span className="text-[11px] text-slate-400 ml-auto">All times Central (Flower Mound, TX)</span>
            </div>

            {staffQ.isLoading && <LoadingState label="Loading staff performance…" />}
            {staffQ.isError && <ErrorState error={staffQ.error} />}
            {staffPeriod === 'custom' && (!staffCustomStart || !staffCustomEnd) && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                Pick a start and end date to view custom-range staff performance.
              </div>
            )}
            {staffQ.data && (() => {
              const d = staffQ.data;
              const topAmount = (d.staff[0]?.amount ?? d.staff[0]?.ytdAmount) ?? 1;
              const periodLabel =
                d.label ?? (d.year ? `${d.year} Year-to-Date` : 'Year to date');
              const rangeText =
                d.fromDate && d.toDate
                  ? `${d.fromDate} – ${d.toDate}`
                  : '';

              // Becky's commission — 4% of her total sales for the selected
              // period. The `amount` field is whatever date window the period
              // selector requested. We deliberately do NOT fall back to the
              // legacy `ytdAmount` field — if the period returns no rows for
              // Becky we want $0, not a stale YTD number.
              const beckyRow = d.staff.find((s) =>
                (s.name ?? '').toLowerCase().includes('becky') ||
                (s.rawName ?? '').toLowerCase().includes('becky')
              );
              const beckyAmount = beckyRow?.amount ?? 0;
              const beckyCommission = beckyAmount * 0.04;
              const dateRangeText =
                d.fromDate && d.toDate
                  ? `${d.fromDate} → ${d.toDate}`
                  : '';

              return (
                <>
                  {/* Becky commission — admin-only */}
                  {isVisible('sales.staff.beckyCommission') && beckyRow && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 flex items-center gap-4">
                      <div className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100">
                        <Trophy className="w-6 h-6 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-emerald-700 uppercase tracking-wide">Becky Commission ({periodLabel})</p>
                        <p className="text-[10px] text-emerald-600 mt-0.5">
                          4% of {fmt(beckyAmount)} sales · paid end of month
                          {dateRangeText && (
                            <span className="text-emerald-500/70"> · {dateRangeText}</span>
                          )}
                        </p>
                      </div>
                      <p className="text-3xl font-bold text-emerald-700 flex-shrink-0">{fmt(beckyCommission)}</p>
                    </div>
                  )}

                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-sm text-slate-600">
                      {periodLabel}
                      {rangeText && <span className="text-slate-400"> · {rangeText}</span>}
                      <span className="text-slate-400"> · {d.totalUsers} users in system</span>
                    </p>
                    <p className="text-xs text-slate-400">
                      As of {new Date(d.asOf).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
                    </p>
                  </div>

                  {d.staff.length === 0 ? (
                    <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-sm text-slate-500">
                      No sales rep data for this period yet. Sales rep names are pulled from ticket records — try a wider window or wait for the next sync.
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Name</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Revenue</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Active Days</th>
                            <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Avg / Day</th>
                            <th className="px-4 py-3 w-40"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {d.staff.map((s, i) => {
                            const amount = s.amount ?? s.ytdAmount ?? 0;
                            return (
                              <tr key={s.rawName} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-medium text-slate-900">
                                  {i === 0 && <span className="mr-1.5 text-amber-500">★</span>}
                                  {s.name}
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-slate-700">{fmt(amount)}</td>
                                <td className="px-4 py-3 text-right text-slate-500">{s.activeDays}</td>
                                <td className="px-4 py-3 text-right font-mono text-slate-600">{fmt(s.avgPerDay)}</td>
                                <td className="px-4 py-3">
                                  <div className="bg-slate-100 rounded-full h-1.5">
                                    <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${(amount / topAmount) * 100}%` }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── INSIGHTS TAB ── */}
        {tab === 'insights' && (() => {
          // Pick a data source based on selected year:
          //   - current year → use the live reportingQ (freshest YTD data)
          //   - prior year or 'all' → use insightsQ which reads per-year caches
          const usingPrior = insightsYear !== currentYearStr;
          const isLoading = usingPrior ? insightsQ.isLoading : reportingQ.isLoading;
          const isError = usingPrior ? insightsQ.isError : reportingQ.isError;
          const error = usingPrior ? insightsQ.error : reportingQ.error;
          // Coalesce — both responses share the brandRows/returnRows/customerInsights shape
          const d: (ReportingResponse & InsightsResponse) | undefined = usingPrior
            ? (insightsQ.data as unknown as ReportingResponse & InsightsResponse)
            : (reportingQ.data as unknown as ReportingResponse & InsightsResponse);
          const availableYears = insightsQ.data?.availableYears ?? [];

          return (
          <div className="space-y-6">
            {/* Year selector */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-600">Period:</span>
              <button
                onClick={() => setInsightsYear(currentYearStr)}
                className={`px-3 py-1 text-sm rounded-full border transition ${
                  insightsYear === currentYearStr
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                }`}
              >
                {currentYearStr} (YTD)
              </button>
              {availableYears
                .filter((y) => String(y) !== currentYearStr)
                .map((y) => (
                  <button
                    key={y}
                    onClick={() => setInsightsYear(String(y))}
                    className={`px-3 py-1 text-sm rounded-full border transition ${
                      insightsYear === String(y)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {y}
                  </button>
                ))}
              <button
                onClick={() => setInsightsYear('all')}
                className={`px-3 py-1 text-sm rounded-full border transition ${
                  insightsYear === 'all'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                }`}
              >
                All available
              </button>
              <span className="text-[11px] text-slate-400 ml-auto">All times Central (Flower Mound, TX)</span>
            </div>

            {isLoading && <LoadingState label="Loading insights…" />}
            {isError && <ErrorState error={error} />}
            {d?.notReady && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                {d.message ?? "Insights data hasn't synced yet. Click \"Sync now\" to populate."}
              </div>
            )}
            {d && !d.notReady && (() => {
              const ci = d.customerInsights;

              // Return rate by brand
              const returnData = (d.returnRows ?? [])
                .filter((r) => (r['source_sales.gross_sales'] as number) > 0)
                .map((r) => {
                  const brand = String(r['item.custom@brand'] ?? 'Unknown');
                  const grossSales = (r['source_sales.gross_sales'] as number) ?? 0;
                  const grossReturns = Math.abs((r['source_sales.gross_returns'] as number) ?? 0);
                  const returnRate = grossSales > 0 ? Math.round((grossReturns / grossSales) * 1000) / 10 : 0;
                  return { brand, grossSales, grossReturns, returnRate };
                })
                .filter((r) => r.grossSales > 0)
                .sort((a, b) => b.returnRate - a.returnRate);

              // Inventory turn — net sales / avg inventory value (only current year)
              const totalInventoryValue = !usingPrior
                ? (inventoryQ.data?.byDepartment ?? []).reduce((s, dept) => s + dept.totalCost, 0)
                : 0;
              const yearNetSales = (d.brandRows ?? []).reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0);
              const inventoryTurn = !usingPrior && totalInventoryValue > 0 ? Math.round((yearNetSales / totalInventoryValue) * 10) / 10 : null;

              // Slow movers — items with stock but no/low sales
              const brandSalesMap: Record<string, number> = {};
              for (const r of d.brandRows ?? []) {
                const brand = String(r['item.custom@brand'] ?? '');
                if (brand) brandSalesMap[brand.toUpperCase()] = (r['source_sales.net_sales'] as number) ?? 0;
              }

              return (
                <>
                  {/* Customer Retention */}
                  {ci && (
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-400" /> Customer Retention (YTD)
                        <BenchmarkTip lines={[
                          'Specialty footwear benchmark: 25–40% repeat rate.',
                          '< 20% — low loyalty; consider follow-up outreach or loyalty program.',
                          '20–30% — average for independent footwear retailers.',
                          '> 35% — strong loyalty, customers are coming back.',
                          'Repeat buyer = customer with 2+ transactions in the period.',
                        ]} />
                      </h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                        <div className="text-center">
                          <p className="text-2xl font-semibold text-slate-900">{ci.totalCustomers}</p>
                          <p className="text-xs text-slate-500 mt-0.5">Total customers</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-semibold text-emerald-600">{ci.repeatCustomers}</p>
                          <p className="text-xs text-slate-500 mt-0.5">Repeat buyers</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-semibold text-blue-600">{ci.newCustomers}</p>
                          <p className="text-xs text-slate-500 mt-0.5">New customers</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-2xl font-semibold ${ci.repeatRate >= 30 ? 'text-emerald-600' : ci.repeatRate >= 20 ? 'text-amber-600' : 'text-red-600'}`}>
                            {fmtPct(ci.repeatRate)}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">Repeat rate</p>
                        </div>
                      </div>
                      <div className="bg-slate-50 rounded p-3 text-xs text-slate-600">
                        Repeat customers generated <strong>{fmt(ci.repeatRevenue)}</strong> ({fmtPct(ci.repeatRevenuePct)} of YTD revenue).
                        {' '}Specialty retail benchmark: 25–40% repeat rate. {ci.repeatRate < 25 ? 'Below benchmark — consider a loyalty program or follow-up outreach.' : ci.repeatRate >= 35 ? 'Above benchmark — strong loyalty.' : 'Within healthy range.'}
                      </div>
                    </div>
                  )}

                  {/* Return Rate by Brand */}
                  {returnData.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
                        <Tag className="w-4 h-4 text-slate-400" /> Return Rate by Brand (YTD)
                        <BenchmarkTip lines={[
                          'Specialty footwear benchmark: < 8% return rate.',
                          '< 5% — excellent; very few fit or quality issues.',
                          '5–8% — normal range for specialty footwear.',
                          '8–15% — elevated; investigate fit, sizing, or quality.',
                          '> 15% — high; may indicate a systemic issue with that brand.',
                        ]} />
                      </h3>
                      <p className="text-xs text-slate-500 mb-4">Brands with high return rates may indicate fit issues, quality problems, or customer expectation mismatches. Benchmark: &lt;8% for specialty footwear.</p>
                      <div className="space-y-2">
                        {returnData.slice(0, 15).map((r) => (
                          <div key={r.brand}>
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-slate-700 font-medium">{r.brand}</span>
                              <span className={`font-medium ${r.returnRate > 15 ? 'text-red-600' : r.returnRate > 8 ? 'text-amber-600' : 'text-emerald-600'}`}>
                                {fmtPct(r.returnRate)} ({fmt(r.grossReturns)} returned of {fmt(r.grossSales)})
                              </span>
                            </div>
                            <div className="w-full bg-slate-100 rounded-full h-1.5">
                              <div className={`h-1.5 rounded-full ${r.returnRate > 15 ? 'bg-red-500' : r.returnRate > 8 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                style={{ width: `${Math.min(100, r.returnRate * 4)}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Inventory Turn Rate */}
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                      <Package className="w-4 h-4 text-slate-400" /> Inventory Turn Rate
                      <BenchmarkTip lines={[
                        'Specialty footwear benchmark: 2–4× per year.',
                        '< 2× — slow-moving stock; consider markdowns or clearance.',
                        '2–3× — moderate; monitor slow-moving categories.',
                        '≥ 3× — healthy; inventory is moving well.',
                        'Formula: YTD net sales ÷ total inventory cost value.',
                        'Your store carries ~$' + (inventoryQ.data ? Math.round((inventoryQ.data.byDepartment ?? []).reduce((s: number, d: {totalCost: number}) => s + d.totalCost, 0) / 1000) + 'K' : '?') + ' in inventory cost.',
                      ]} />
                    </h3>
                    {inventoryTurn !== null ? (
                      <>
                        <div className="text-center py-4">
                          <p className={`text-4xl font-bold ${inventoryTurn >= 3 ? 'text-emerald-600' : inventoryTurn >= 2 ? 'text-amber-600' : 'text-red-600'}`}>
                            {inventoryTurn}×
                          </p>
                          <p className="text-sm text-slate-500 mt-1">turns per year</p>
                        </div>
                        <div className="bg-slate-50 rounded p-3 text-xs text-slate-600">
                          {inventoryTurn >= 3 ? '✓ Healthy — inventory is moving well.' : inventoryTurn >= 2 ? '⚠ Moderate — some slow-moving stock. Review clearance candidates.' : '⚠ Low — significant capital tied up in slow inventory. Consider markdowns.'}
                          {' '}Specialty footwear benchmark: 2–4× per year. Calculated as YTD net sales ÷ inventory cost value.
                        </div>
                      </>
                    ) : usingPrior ? (
                      <p className="text-sm text-slate-400 italic">Inventory turn is calculated against current stock levels — not available for prior-year views.</p>
                    ) : (
                      <p className="text-sm text-slate-400 italic">Requires inventory sync to calculate.</p>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
          );
        })()}

        {/* ── PURCHASING / VENDORS TAB ──
            Both tabs share the same purchasingQ data fetch + IIFE. The
            Vendors tab shows ONLY the Vendor Directory; Purchasing shows
            everything else. The internal `showVendors` flag drives the
            split inside the IIFE below. */}
        {(tab === 'purchasing' || tab === 'vendors') && (
          <div className="space-y-6">
            {purchasingQ.isLoading && <LoadingState label="Loading purchasing data…" />}
            {purchasingQ.isError && <ErrorState error={purchasingQ.error} />}
            {purchasingQ.data?.notReady && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                {purchasingQ.data.message} Click "Sync now" to populate.
              </div>
            )}
            {purchasingQ.data && !purchasingQ.data.notReady && (() => {
              const d = purchasingQ.data;
              const showVendors = tab === 'vendors';
              const showPurchasing = tab === 'purchasing';
              return (
                <>
                  {/* Open orders — top of Purchasing tab */}
                  {showPurchasing && d.orders.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100">
                        <h3 className="text-sm font-semibold text-slate-900">Open / Pending Orders</h3>
                        <p className="text-xs text-slate-500 mt-0.5">Last synced {relativeTime(d.cachedAt)} · click any row to view line items</p>
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
                            {[...d.orders]
                              .sort((a, b) => {
                                // Newest first by created_at; rows with no
                                // date sink to the bottom.
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
                    </div>
                  )}

                  {/* Vendor / Order stat cards — Vendors tab only */}
                  {showVendors && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <StatCard label="Vendors" value={d.vendorCount.toLocaleString()} sub="active suppliers" icon={ShoppingBag} color="blue" />
                    <StatCard label="Total Orders" value={d.totalOrders.toLocaleString()} sub="all time" icon={Package} color="green" />
                    <StatCard label="Open Orders" value={d.openOrderCount.toLocaleString()} sub="pending or open" icon={TrendingUp} color="amber" />
                  </div>
                  )}

                  {/* ── Payment Processor — Purchasing only ── */}
                  {showPurchasing && (
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-3">Payment Processor</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div>
                        <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">Processor</p>
                        <p className="text-sm font-semibold text-slate-800">CardPointe</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">Merchant ID</p>
                        <p className="text-sm font-mono text-slate-800 select-all">496636327884</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">Username</p>
                        <p className="text-sm font-mono text-slate-800 select-all">496636327884</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">Support</p>
                        <a href="mailto:support@securetrust.com" className="text-sm text-blue-600 hover:underline block">support@securetrust.com</a>
                        <a href="tel:8778280720" className="text-sm text-blue-600 hover:underline block">877-828-0720</a>
                      </div>
                    </div>
                  </div>
                  )}

                  {/* ── Payment Methods (analytics-driven) — Purchasing only ── */}
                  {showPurchasing && analyticsQ.data && analyticsQ.data.paymentMethods.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-slate-400" /> Payment Methods
                      </h3>
                      <p className="text-xs text-slate-500 mb-4">
                        Last {analyticsDays} days · sales by payment type
                      </p>
                      <div className="space-y-3">
                        {analyticsQ.data.paymentMethods.map((pm) => (
                          <div key={pm.id}>
                            <HBar label={pm.name} value={pm.amount} max={analyticsQ.data!.paymentMethods[0]?.amount ?? 1} />
                            <p className="text-[10px] text-slate-400 ml-[8.5rem] mt-0.5">{pm.count} transactions · {fmtPct(pm.pct)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Open orders — moved to top of Purchasing tab */}

                  {/* Vendor directory with contact info — Vendors tab only */}
                  {showVendors && (
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-1">Vendor Directory ({d.vendorCount - 1})</h3>
                    <p className="text-xs text-slate-500 mb-4">
                      Sorted by YTD net sales (highest first). Check the box to mark an active account.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {(() => {
                        // Build a brand→sales map from reporting data (most accurate)
                        const brandSales: Record<string, number> = {};
                        if (reportingQ.data?.brandRows) {
                          for (const row of reportingQ.data.brandRows) {
                            const brand = row['item.custom@brand'] as string | undefined;
                            const sales = (row['source_sales.net_sales'] as number) ?? 0;
                            if (brand) brandSales[brand.toUpperCase()] = sales;
                          }
                        }
                        // Fall back to PO received qty rank if no reporting data
                        const rankMap: Record<number, number> = {};
                        for (const r of d.vendorRank ?? []) {
                          rankMap[r.vendorId] = r.totalReceivedQty;
                        }

                        const sorted = [...d.vendors].filter((v) => {
                          // Exclude self — "Foot Solutions Inc" is the store itself, not a supplier
                          const name = (v.name ?? '').toLowerCase();
                          return !name.includes('foot solutions inc') && !name.includes('fs corp');
                        }).sort((a, b) => {
                          const nameA = (a.name ?? '').toUpperCase();
                          const nameB = (b.name ?? '').toUpperCase();
                          const salesA = brandSales[nameA] ?? rankMap[a.id] ?? 0;
                          const salesB = brandSales[nameB] ?? rankMap[b.id] ?? 0;
                          return salesB - salesA;
                        });

                        return sorted.map((v) => {
                          const info = VENDOR_CONTACTS[v.name?.toUpperCase() ?? ''] ?? VENDOR_CONTACTS[v.name ?? ''];
                          const ov = vendorOverrides[v.id] ?? {};
                          const key = `vendor-account:${v.id}`;
                          const hasAccount = activeAccounts.has(key);
                          const isDiscontinued = discontinuedVendors.has(key);
                          const isContacted = !hasAccount && contactedVendors.has(key);
                          const ytdSales = brandSales[(v.name ?? '').toUpperCase()];
                          const rankRow = (d.vendorRank ?? []).find((r) => r.vendorId === v.id);
                          const openOrders = rankRow?.openOrders ?? 0;
                          const totalOrders = rankRow?.totalOrders ?? 0;
                          const isEditingCard = editingVendorCard === v.id;

                          // Merge: override wins over VENDOR_CONTACTS, which wins over nothing
                          const displayName = ov.displayName ?? displayVendorName(v.name, `Vendor ${v.id}`);
                          const phone   = ov.phone   ?? info?.phone;
                          const email   = ov.email   ?? info?.email;
                          const website = ov.website ?? info?.website;
                          const repName  = ov.repName  ?? info?.rep?.name;
                          const repPhone = ov.repPhone ?? info?.rep?.phone;
                          const repEmail = ov.repEmail ?? info?.rep?.email;
                          const repTitle = ov.repTitle ?? (info?.rep?.name ? '' : undefined);
                          const hasRep = repName || repPhone || repEmail;

                          const inputCls = "w-full text-[11px] border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white";

                          return (
                            <div
                              key={v.id}
                              className={`relative rounded-lg border p-3 transition ${
                                isDiscontinued ? 'border-amber-300 bg-amber-50'
                                  : hasAccount ? 'border-emerald-300 bg-emerald-50'
                                  : isContacted ? 'border-yellow-300 bg-yellow-50'
                                  : 'border-slate-100 bg-slate-50 hover:border-slate-300'
                              }`}
                            >
                              {/* ── Header row ── */}
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <p className={`text-xs font-semibold truncate ${isDiscontinued ? 'text-amber-900' : hasAccount ? 'text-emerald-900' : isContacted ? 'text-yellow-900' : 'text-slate-900'}`}>
                                      {displayName}
                                      {isDiscontinued && <span className="ml-1.5 text-[10px] font-medium text-amber-700 bg-amber-100 px-1 py-0.5 rounded">Discontinuing</span>}
                                    </p>
                                    <button
                                      onClick={() => {
                                        setEditingVendorCard(v.id);
                                        setVendorCardDraft({
                                          displayName: ov.displayName ?? displayVendorName(v.name, `Vendor ${v.id}`),
                                          phone:   ov.phone   ?? info?.phone   ?? '',
                                          email:   ov.email   ?? info?.email   ?? '',
                                          website: ov.website ?? info?.website ?? '',
                                          repName:  ov.repName  ?? info?.rep?.name  ?? '',
                                          repPhone: ov.repPhone ?? info?.rep?.phone ?? '',
                                          repEmail: ov.repEmail ?? info?.rep?.email ?? '',
                                          repTitle: ov.repTitle ?? '',
                                        });
                                        setInlineEdit(null);
                                        setEditingContactsFor(null);
                                      }}
                                      className="flex-shrink-0 text-slate-300 hover:text-blue-500 transition-colors"
                                      title="Edit vendor card"
                                    >
                                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    </button>
                                  </div>
                                  {ytdSales != null && ytdSales > 0 && (
                                    <p className="text-[10px] text-slate-400">{fmt(ytdSales)} YTD</p>
                                  )}
                                  {(totalOrders > 0 || openOrders > 0) && (
                                    <p className="text-[10px] text-slate-400">
                                      {openOrders > 0 && (
                                        <button type="button" onClick={() => setOrderModalVendor({ id: v.id, name: displayName })} className="text-blue-600 font-medium hover:underline focus:outline-none">
                                          {openOrders} open ▸
                                        </button>
                                      )}
                                      {openOrders > 0 && totalOrders > 0 && <span> · </span>}
                                      {totalOrders > 0 && <span>{totalOrders} total order{totalOrders === 1 ? '' : 's'}</span>}
                                    </p>
                                  )}
                                </div>
                                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                  <label className="flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" checked={hasAccount} onChange={(e) => handleVendorAccountToggle(key, v.name ?? `Vendor ${v.id}`, e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer" />
                                    <span className={`text-[10px] ${hasAccount ? 'text-emerald-700 font-medium' : 'text-slate-400'}`}>{hasAccount ? 'Active' : 'Account?'}</span>
                                  </label>
                                  {!hasAccount && (
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input type="checkbox" checked={isContacted} onChange={(e) => handleContactedToggle(key, e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-yellow-500 focus:ring-yellow-400 cursor-pointer" />
                                      <span className={`text-[10px] ${isContacted ? 'text-yellow-700 font-medium' : 'text-slate-400'}`}>{isContacted ? 'Contacted' : 'Contacted?'}</span>
                                    </label>
                                  )}
                                </div>
                              </div>

                              {/* ── Comments (shown on contacted/yellow OR active/green cards) ── */}
                              {(isContacted || hasAccount) && (
                                <div className="mt-1.5 mb-1">
                                  <textarea
                                    rows={2}
                                    key={`note-${key}`}
                                    defaultValue={contactNotes[key] ?? ''}
                                    onBlur={(e) => handleContactNoteChange(key, e.target.value)}
                                    placeholder={hasAccount ? 'Comments about this account…' : 'Notes about this contact…'}
                                    className={`w-full text-[11px] rounded-lg px-2.5 py-1.5 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 resize-none ${
                                      hasAccount
                                        ? 'border border-emerald-200 bg-emerald-50 focus:ring-emerald-400'
                                        : 'border border-yellow-200 bg-yellow-50 focus:ring-yellow-400'
                                    }`}
                                  />
                                </div>
                              )}

                              {/* ── Edit card form ── */}
                              {isEditingCard ? (
                                <div className="mt-2 pt-2 border-t border-slate-200 space-y-1.5 bg-white rounded-lg border border-blue-200 p-2">
                                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Edit Vendor Card</p>
                                  <label className="text-[10px] text-slate-400">Display Name</label>
                                  <input type="text" value={vendorCardDraft.displayName ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, displayName: e.target.value }))} className={inputCls} placeholder="Display name" />
                                  <label className="text-[10px] text-slate-400">Phone</label>
                                  <input type="tel" value={vendorCardDraft.phone ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, phone: e.target.value }))} className={inputCls} placeholder="Phone" />
                                  <label className="text-[10px] text-slate-400">Email</label>
                                  <input type="email" value={vendorCardDraft.email ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, email: e.target.value }))} className={inputCls} placeholder="Email" />
                                  <label className="text-[10px] text-slate-400">Website</label>
                                  <input type="text" value={vendorCardDraft.website ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, website: e.target.value }))} className={inputCls} placeholder="https://..." />
                                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide pt-1">Rep</p>
                                  <input type="text" value={vendorCardDraft.repName ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, repName: e.target.value }))} className={inputCls} placeholder="Rep name" />
                                  <input type="text" value={vendorCardDraft.repTitle ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, repTitle: e.target.value }))} className={inputCls} placeholder="Rep title / role" />
                                  <input type="tel" value={vendorCardDraft.repPhone ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, repPhone: e.target.value }))} className={inputCls} placeholder="Rep phone" />
                                  <input type="email" value={vendorCardDraft.repEmail ?? ''} onChange={(e) => setVendorCardDraft((d) => ({ ...d, repEmail: e.target.value }))} className={inputCls} placeholder="Rep email" />
                                  <div className="flex gap-1.5 pt-1">
                                    <button onClick={() => saveVendorCard(v.id)} className="flex-1 text-[11px] py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 transition">Save</button>
                                    <button onClick={() => setEditingVendorCard(null)} className="flex-1 text-[11px] py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 transition">Cancel</button>
                                    {vendorOverrides[v.id] && (
                                      <button onClick={() => resetVendorCard(v.id)} className="text-[11px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 transition" title="Reset to defaults">Reset</button>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                /* ── Contact info display ── */
                                <div className="space-y-0.5">
                                  {phone && <a href={`tel:${phone.replace(/\D/g,'')}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"><span>📞</span>{phone}</a>}
                                  {email && <a href={`mailto:${email}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 truncate"><span>✉</span>{email}</a>}
                                  {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:underline flex items-center gap-1 truncate"><span>🌐</span>{website.replace('https://','').replace('www.','')}</a>}
                                  {hasRep && (
                                    <div className="mt-1.5 pt-1.5 border-t border-slate-200 space-y-0.5">
                                      <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Rep</p>
                                      {repName && <p className="text-[11px] text-slate-700 font-medium">{repName}{repTitle && <span className="font-normal text-slate-400"> — {repTitle}</span>}</p>}
                                      {repPhone && <a href={`tel:${repPhone.replace(/\D/g,'')}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"><span>📞</span>{repPhone}</a>}
                                      {repEmail && <a href={`mailto:${repEmail}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 truncate"><span>✉</span>{repEmail}</a>}
                                      {info?.rep?.account && <p className="text-[11px] text-slate-500">Acct # {info.rep.account}</p>}
                                    </div>
                                  )}
                                  {!phone && !email && !website && !hasRep && (
                                    <p className="text-[11px] text-slate-400 italic">No contact info — click ✏ to add</p>
                                  )}
                                </div>
                              )}

                              {/* ── Custom contacts ── */}
                              {(() => {
                                const contacts = customContacts[v.id] ?? [];
                                const isAdding = editingContactsFor === v.id;
                                const inputCls = "w-full text-[11px] border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white";
                                return (
                                  <div className="mt-2 pt-2 border-t border-slate-200">
                                    {/* Existing contacts */}
                                    {contacts.length > 0 && (
                                      <div className="space-y-2 mb-2">
                                        {contacts.map((c) => {
                                          const isEditingThis = inlineEdit?.vendorId === v.id && inlineEdit?.contactId === c.id;
                                          if (isEditingThis) {
                                            return (
                                              <div key={c.id} className="bg-blue-50 border border-blue-200 rounded-lg p-2 space-y-1">
                                                <input type="text" placeholder="Name" value={inlineEditDraft.name ?? ''} onChange={(e) => setInlineEditDraft((d) => ({ ...d, name: e.target.value }))} className={inputCls} />
                                                <input type="text" placeholder="Title / Role" value={inlineEditDraft.title ?? ''} onChange={(e) => setInlineEditDraft((d) => ({ ...d, title: e.target.value }))} className={inputCls} />
                                                <input type="tel" placeholder="Phone" value={inlineEditDraft.phone ?? ''} onChange={(e) => setInlineEditDraft((d) => ({ ...d, phone: e.target.value }))} className={inputCls} />
                                                <input type="email" placeholder="Email" value={inlineEditDraft.email ?? ''} onChange={(e) => setInlineEditDraft((d) => ({ ...d, email: e.target.value }))} className={inputCls} />
                                                <div className="flex gap-1.5 pt-0.5">
                                                  <button onClick={() => saveInlineEdit(v.id, c.id)} className="flex-1 text-[11px] py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 transition">Save</button>
                                                  <button onClick={() => setInlineEdit(null)} className="flex-1 text-[11px] py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 transition">Cancel</button>
                                                  <button onClick={() => { removeCustomContact(v.id, c.id); setInlineEdit(null); }} className="text-[11px] py-1 px-2 rounded border border-red-200 text-red-500 hover:bg-red-50 transition">Delete</button>
                                                </div>
                                              </div>
                                            );
                                          }
                                          return (
                                            <div key={c.id} className="flex items-start gap-1.5 group">
                                              <div className="flex-1 min-w-0">
                                                {(c.name || c.title) && (
                                                  <p className="text-[11px] font-medium text-slate-700">
                                                    {c.name}{c.name && c.title && <span className="font-normal text-slate-400"> — </span>}{c.title && <span className="font-normal text-slate-500">{c.title}</span>}
                                                  </p>
                                                )}
                                                {c.phone && <a href={`tel:${c.phone.replace(/\D/g,'')}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"><span>📞</span>{c.phone}</a>}
                                                {c.email && <a href={`mailto:${c.email}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 truncate"><span>✉</span>{c.email}</a>}
                                              </div>
                                              {/* Edit pencil — always visible, not just on hover */}
                                              <button
                                                onClick={() => { setInlineEdit({ vendorId: v.id, contactId: c.id }); setInlineEditDraft({ name: c.name ?? '', title: c.title ?? '', phone: c.phone ?? '', email: c.email ?? '' }); setEditingContactsFor(null); }}
                                                className="flex-shrink-0 text-slate-300 hover:text-blue-500 transition-colors"
                                                title="Edit contact"
                                              >
                                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}

                                    {/* Add new contact form */}
                                    {isAdding ? (
                                      <div className="space-y-1.5 bg-white rounded-lg border border-blue-200 p-2">
                                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">New Contact — fill any fields</p>
                                        <input type="text" placeholder="Name" value={contactDraft.name ?? ''} onChange={(e) => setContactDraft((d) => ({ ...d, name: e.target.value }))} className={inputCls} />
                                        <input type="text" placeholder="Title / Role" value={contactDraft.title ?? ''} onChange={(e) => setContactDraft((d) => ({ ...d, title: e.target.value }))} className={inputCls} />
                                        <input type="tel" placeholder="Phone" value={contactDraft.phone ?? ''} onChange={(e) => setContactDraft((d) => ({ ...d, phone: e.target.value }))} className={inputCls} />
                                        <input type="email" placeholder="Email" value={contactDraft.email ?? ''} onChange={(e) => setContactDraft((d) => ({ ...d, email: e.target.value }))} className={inputCls} />
                                        <div className="flex gap-1.5 pt-0.5">
                                          <button
                                            onClick={() => addCustomContact(v.id)}
                                            disabled={!contactDraft.name?.trim() && !contactDraft.phone?.trim() && !contactDraft.email?.trim() && !contactDraft.title?.trim()}
                                            className="flex-1 text-[11px] py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 transition"
                                          >
                                            Save
                                          </button>
                                          <button
                                            onClick={() => { setEditingContactsFor(null); setContactDraft({ name: '', title: '', phone: '', email: '' }); }}
                                            className="flex-1 text-[11px] py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => { setEditingContactsFor(v.id); setContactDraft({ name: '', title: '', phone: '', email: '' }); setInlineEdit(null); }}
                                        className="text-[11px] text-blue-500 hover:text-blue-700 flex items-center gap-1 transition"
                                      >
                                        <span className="text-base leading-none">+</span> Add contact
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── Discontinue button — bottom-right corner ── */}
                              <div className="flex justify-end mt-2">
                                <button type="button" onClick={() => handleDiscontinuedToggle(key, v.name ?? `Vendor ${v.id}`)}
                                  className={`text-[10px] px-1.5 py-0.5 rounded border transition ${isDiscontinued ? 'border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200' : 'border-slate-200 text-slate-400 hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50'}`}>
                                  {isDiscontinued ? '⚠ Discontinuing' : 'Discontinue?'}
                                </button>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                  )}

                  {/* Open orders — moved to top of Purchasing tab; this slot intentionally empty */}
                </>
              );
            })()}
            {tab === 'purchasing' && <VendorHealthCard />}
          </div>
        )}

        {/* ── REPORTING TAB ── */}
        {tab === 'reporting' && (
          <div className="space-y-6">
            {reportingQ.isLoading && <LoadingState label="Loading reporting data…" />}
            {reportingQ.isError && <ErrorState error={reportingQ.error} />}
            {reportingQ.data?.notReady && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                {reportingQ.data.message} Click "Sync now" to populate.
              </div>
            )}
            {reportingQ.data && !reportingQ.data.notReady && (() => {
              const d = reportingQ.data;
              return (
                <>
                  <p className="text-sm text-slate-500">
                    YTD net sales from Heartland Reporting Analyzer · {fmtDate(d.yearStart ?? d.fromDate)} – {fmtDate(d.toDate)} · Flower Mound only
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <StatCard label="YTD Net Sales" value={fmt(d.summary.totalNetSales)} sub="after discounts & returns" icon={TrendingUp} color="blue" />
                    <StatCard label="YTD Transactions" value={d.summary.totalTransactions.toLocaleString()} sub="completed tickets" icon={ShoppingBag} color="green" />
                    <StatCard
                      label="YTD Net Margin"
                      value={d.summary.totalNetMargin != null ? fmt(d.summary.totalNetMargin) : '—'}
                      sub={
                        d.summary.totalNetMargin != null && d.summary.avgNetMarginPct != null
                          ? `${fmtPct(d.summary.avgNetMarginPct)} avg margin`
                          : 'Margin not exposed by Heartland token'
                      }
                      icon={Tag}
                      color="purple"
                    />
                  </div>

                  {/* Daily net sales chart */}
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <h3 className="text-sm font-semibold text-slate-900 mb-1">Daily Net Sales (last 30 days)</h3>
                    <p className="text-xs text-slate-500 mb-4">From Heartland Reporting Analyzer — hover any point for details. All times Central (Flower Mound, TX).</p>
                    <LineChart
                      data={d.dailyRows.map((r) => ({
                        date: String(r['date.date'] ?? ''),
                        amount: (r['source_sales.net_sales'] as number) ?? 0,
                        meta: {
                          transactions: (r['source_sales.transaction_count'] as number) ?? 0,
                        },
                      }))}
                      height={280}
                      yLabel="Net Sales ($)"
                      xLabel="Date"
                      tooltipExtra={(p) => {
                        const txn = (p.meta?.transactions as number) ?? 0;
                        if (!txn) return null;
                        const avg = p.amount / txn;
                        return `${txn.toLocaleString()} ticket${txn === 1 ? '' : 's'} · avg ${fmt(avg)}`;
                      }}
                    />
                  </div>

                  {/* Daily table */}
                  <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-100">
                      <h3 className="text-sm font-semibold text-slate-900">Daily Breakdown (last 30 days)</h3>
                      <p className="text-xs text-slate-500 mt-0.5">Margin omitted from this view — Heartland's analyzer doesn't compute it at the daily grain.</p>
                    </div>
                    <div className="overflow-x-auto max-h-96">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-50">
                          <tr className="border-b border-slate-100">
                            <th className="text-left px-4 py-2 text-slate-500 font-medium">Date</th>
                            <th className="text-right px-4 py-2 text-slate-500 font-medium">Net Sales</th>
                            <th className="text-right px-4 py-2 text-slate-500 font-medium">Transactions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {[...d.dailyRows].reverse().map((r, i) => (
                            <tr key={i} className="hover:bg-slate-50">
                              <td className="px-4 py-1.5 text-slate-600">{String(r['date.date'] ?? '')}</td>
                              <td className="px-4 py-1.5 text-right font-mono text-slate-700">{fmt((r['source_sales.net_sales'] as number) ?? 0)}</td>
                              <td className="px-4 py-1.5 text-right text-slate-600">{((r['source_sales.transaction_count'] as number) ?? 0).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Brand breakdown */}
                  {d.brandRows && d.brandRows.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1">YTD Net Sales by Brand</h3>
                      <p className="text-xs text-slate-500 mb-4">
                        Brands stored with mixed casing in Heartland (e.g. "NAOT" + "naot") are merged here. Items with no brand attribute show as "(brand not set)".
                      </p>
                      <div className="space-y-2">
                        {d.brandRows.filter((r) => (r['source_sales.net_sales'] as number) > 0).map((r, i) => {
                          const brand = String(r['item.custom@brand'] ?? 'Unknown');
                          const sales = (r['source_sales.net_sales'] as number) ?? 0;
                          const maxSales = (d.brandRows[0]?.['source_sales.net_sales'] as number) ?? 1;
                          const variantCount = r.variantCount;
                          const isNullBrand = r.isNullBrand;
                          const variants = r.variants;
                          return (
                            <div key={i}>
                              <div className="flex items-center justify-between text-xs mb-0.5">
                                <span className={`font-medium ${isNullBrand ? 'text-amber-700 italic' : 'text-slate-700'}`}>
                                  {brand}
                                  {variantCount && variantCount > 1 && (
                                    <span
                                      className="ml-1.5 text-[10px] text-blue-600 cursor-help"
                                      title={`Merged ${variantCount} case variants: ${variants?.join(', ')}`}
                                    >
                                      ⓘ merged {variantCount} variants
                                    </span>
                                  )}
                                </span>
                                <span className="font-mono text-slate-700">{fmt(sales)}</span>
                              </div>
                              <div className="w-full bg-slate-100 rounded-full h-1.5">
                                <div className={`h-1.5 rounded-full ${isNullBrand ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${(sales / maxSales) * 100}%` }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

      </main>

      {/* Per-vendor open orders modal */}
      {orderModalVendor && purchasingQ.data && (() => {
        const vendorOrders = purchasingQ.data.orders
          .filter((o) => o.vendor_id === orderModalVendor.id)
          .slice()
          .sort((a, b) => {
            const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
            return tb - ta; // newest first
          });
        const totalOpenCost = vendorOrders.reduce((s, o) => s + (o.total_cost ?? 0), 0);
        const totalOpenQty = vendorOrders.reduce((s, o) => s + (o.total_open_qty ?? 0), 0);
        const vendorInfo = VENDOR_CONTACTS[orderModalVendor.name.toUpperCase()] ?? VENDOR_CONTACTS[orderModalVendor.name];
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
            onClick={(e) => { if (e.target === e.currentTarget) { setOrderModalVendor(null); setExpandedOrderId(null); } }}
          >
            <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[85vh] flex flex-col">
              {/* Header */}
              <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 id="order-modal-title" className="text-base font-semibold text-slate-900">
                    Open orders — {orderModalVendor.name}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {vendorOrders.length} open order{vendorOrders.length === 1 ? '' : 's'} · {totalOpenQty.toFixed(0)} units pending · {fmt(totalOpenCost)} total committed
                  </p>
                  {vendorInfo && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      {vendorInfo.phone && (
                        <a href={`tel:${vendorInfo.phone.replace(/\D/g,'')}`} className="text-blue-600 hover:underline flex items-center gap-1">
                          <span>📞</span> {vendorInfo.phone}
                        </a>
                      )}
                      {vendorInfo.email && (
                        <a href={`mailto:${vendorInfo.email}`} className="text-blue-600 hover:underline flex items-center gap-1">
                          <span>✉</span> {vendorInfo.email}
                        </a>
                      )}
                      {vendorInfo.rep && (
                        <div className="flex items-center gap-2 text-xs ml-2 pl-3 border-l border-slate-200">
                          <span className="text-slate-500">Rep:</span>
                          <span className="text-slate-700 font-medium">{vendorInfo.rep.name}</span>
                          {vendorInfo.rep.phone && (
                            <a href={`tel:${vendorInfo.rep.phone.replace(/\D/g,'')}`} className="text-blue-600 hover:underline">
                              {vendorInfo.rep.phone}
                            </a>
                          )}
                          {vendorInfo.rep.email && (
                            <a href={`mailto:${vendorInfo.rep.email}`} className="text-blue-600 hover:underline truncate">
                              {vendorInfo.rep.email}
                            </a>
                          )}
                          {vendorInfo.rep.account && (
                            <span className="text-slate-500">Acct {vendorInfo.rep.account}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 -mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      const sections: CsvSection[] = [
                        {
                          title: `Open Orders — ${orderModalVendor.name}`,
                          subtitle: `${vendorOrders.length} open order${vendorOrders.length === 1 ? '' : 's'} · ${totalOpenQty.toFixed(0)} units pending · ${fmt(totalOpenCost)} total committed · Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
                          headers: ['Field', 'Value'],
                          rows: [
                            ['Vendor', orderModalVendor.name],
                            ['Phone', vendorInfo?.phone ?? ''],
                            ['Email', vendorInfo?.email ?? ''],
                            ['Website', vendorInfo?.website ?? ''],
                            ['Rep Name', vendorInfo?.rep?.name ?? ''],
                            ['Rep Phone', vendorInfo?.rep?.phone ?? ''],
                            ['Rep Email', vendorInfo?.rep?.email ?? ''],
                            ['Account #', vendorInfo?.rep?.account ?? ''],
                          ],
                        },
                        {
                          title: 'Open Orders (newest first)',
                          headers: [
                            'PO #', 'Status', 'Created', 'Days Open',
                            'Qty Ordered', 'Qty Received', 'Qty Open', 'Cost (USD)',
                          ],
                          rows: vendorOrders.map((o) => {
                            const ordered = o.total_qty ?? 0;
                            const open = o.total_open_qty ?? 0;
                            const created = o.created_at ? new Date(o.created_at) : null;
                            const days = created
                              ? Math.floor((Date.now() - created.getTime()) / 86400000)
                              : '';
                            return [
                              String(o.public_id ?? o.id),
                              o.status ?? '',
                              created
                                ? created.toLocaleDateString('en-US', { timeZone: 'America/Chicago' })
                                : '',
                              days,
                              ordered,
                              ordered - open,
                              open,
                              csvNum(o.total_cost ?? 0),
                            ];
                          }),
                        },
                      ];
                      // Append line items section for any orders the user has expanded (lazy-loaded already)
                      const linesByOrder = vendorOrders
                        .map((o) => {
                          const cached = orderLinesCache[o.id];
                          if (!cached || cached.error || cached.lines.length === 0) return null;
                          return { o, lines: cached.lines };
                        })
                        .filter((x): x is { o: typeof vendorOrders[number]; lines: OrderLine[] } => x !== null);
                      if (linesByOrder.length > 0) {
                        sections.push({
                          title: 'Line Items (only for expanded orders)',
                          headers: [
                            'PO #', 'SKU', 'Item', 'Size / Width / Color',
                            'Qty Ordered', 'Qty Received', 'Qty Open',
                            'Unit Cost (USD)', 'Extended (USD)',
                          ],
                          rows: linesByOrder.flatMap(({ o, lines }) =>
                            lines.map((l) => [
                              String(o.public_id ?? o.id),
                              l.sku ?? '',
                              l.name ?? `Item ${l.item_id}`,
                              [l.size, l.width, l.color].filter(Boolean).join(' / '),
                              l.qty?.toFixed(0) ?? '',
                              l.qty_received?.toFixed(0) ?? '',
                              l.qty_open?.toFixed(0) ?? '',
                              l.unit_cost != null ? csvNum(l.unit_cost) : '',
                              l.extended_cost != null ? csvNum(l.extended_cost) : '',
                            ])
                          ),
                        });
                      }
                      const slug = `open_orders_${orderModalVendor.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
                      downloadCsvSections(stampedName(slug), sections);
                    }}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
                    title="Download a CSV of these open orders. Expand rows first to include line-item detail."
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => { setOrderModalVendor(null); setExpandedOrderId(null); }}
                    aria-label="Close"
                    className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto">
                {vendorOrders.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    No open orders for this vendor.
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 sticky top-0">
                        <th className="text-left px-3 py-2 text-slate-500 font-medium w-6"></th>
                        <th className="text-left px-3 py-2 text-slate-500 font-medium">PO #</th>
                        <th className="text-left px-3 py-2 text-slate-500 font-medium">Status</th>
                        <th className="text-left px-3 py-2 text-slate-500 font-medium">Created</th>
                        <th className="text-left px-3 py-2 text-slate-500 font-medium">Days Open</th>
                        <th className="text-right px-3 py-2 text-slate-500 font-medium">Ordered</th>
                        <th className="text-right px-3 py-2 text-slate-500 font-medium">Received</th>
                        <th className="text-right px-3 py-2 text-slate-500 font-medium">Open</th>
                        <th className="text-right px-3 py-2 text-slate-500 font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {vendorOrders.map((o) => {
                        const ordered = o.total_qty ?? 0;
                        const open = o.total_open_qty ?? 0;
                        const received = ordered - open;
                        const created = o.created_at ? new Date(o.created_at) : null;
                        const daysOpen = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : null;
                        // Color coding by age (matches user's preference: ≤7d green, 8-30d yellow, 30d+ red)
                        let ageColor = 'text-slate-500';
                        let ageBg = '';
                        let ageDot = 'bg-slate-300';
                        if (daysOpen !== null) {
                          if (daysOpen <= 7) { ageColor = 'text-emerald-700'; ageBg = 'bg-emerald-50'; ageDot = 'bg-emerald-500'; }
                          else if (daysOpen <= 30) { ageColor = 'text-amber-700'; ageBg = 'bg-amber-100'; ageDot = 'bg-amber-500'; }
                          else { ageColor = 'text-red-700'; ageBg = 'bg-red-100'; ageDot = 'bg-red-500'; }
                        }
                        const isExpanded = expandedOrderId === o.id;
                        const lines = orderLinesCache[o.id];
                        return (
                          <Fragment key={o.id}>
                            <tr
                              className={`hover:bg-slate-50 cursor-pointer ${ageBg}`}
                              onClick={() => {
                                if (isExpanded) {
                                  setExpandedOrderId(null);
                                } else {
                                  setExpandedOrderId(o.id);
                                  if (!orderLinesCache[o.id]) {
                                    void loadOrderLines(o.id);
                                  }
                                }
                              }}
                            >
                              <td className="px-3 py-2 text-slate-400">{isExpanded ? '▾' : '▸'}</td>
                              <td className="px-3 py-2 font-mono text-slate-700">
                                <span className="flex items-center gap-1.5">
                                  {o.public_id ?? o.id}
                                  <CopyPoButton po={String(o.public_id ?? o.id)} />
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${o.status === 'open' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {o.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-slate-500">
                                {created ? created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }) : '—'}
                              </td>
                              <td className={`px-3 py-2 ${ageColor}`}>
                                {daysOpen !== null ? (
                                  <span className="inline-flex items-center gap-1.5 font-medium">
                                    <span className={`w-1.5 h-1.5 rounded-full ${ageDot}`} />
                                    {daysOpen}d
                                  </span>
                                ) : '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-slate-700">{ordered.toFixed(0)}</td>
                              <td className="px-3 py-2 text-right text-slate-600">{received.toFixed(0)}</td>
                              <td className={`px-3 py-2 text-right font-medium ${open > 0 ? 'text-blue-600' : 'text-slate-400'}`}>{open.toFixed(0)}</td>
                              <td className="px-3 py-2 text-right font-mono text-slate-700">{o.total_cost != null ? fmt(o.total_cost) : '—'}</td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-slate-50">
                                <td colSpan={9} className="px-4 py-3">
                                  {!lines ? (
                                    <div className="flex items-center gap-2 text-xs text-slate-500">
                                      <Spinner size="sm" /> Loading line items…
                                    </div>
                                  ) : lines.error ? (
                                    <p className="text-xs text-red-600">Failed to load: {lines.error}</p>
                                  ) : lines.lines.length === 0 ? (
                                    <p className="text-xs text-slate-500 italic">No line items found.</p>
                                  ) : (
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-[11px]">
                                        <thead>
                                          <tr className="text-slate-400 border-b border-slate-200">
                                            <th className="text-left py-1 font-medium">SKU / UPC</th>
                                            <th className="text-left py-1 font-medium">Item</th>
                                            <th className="text-left py-1 font-medium">Size / Width / Color</th>
                                            <th className="text-right py-1 font-medium">Qty Ord</th>
                                            <th className="text-right py-1 font-medium">Recvd</th>
                                            <th className="text-right py-1 font-medium">Open</th>
                                            <th className="text-right py-1 font-medium">Unit $</th>
                                            <th className="text-right py-1 font-medium">Ext $</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                          {lines.lines.map((l) => (
                                            <tr key={l.id} className="hover:bg-white">
                                              <td className="py-1 font-mono text-slate-500">{l.sku ?? '—'}</td>
                                              <td className="py-1 text-slate-700 max-w-[200px] truncate" title={l.name}>{l.name ?? `Item ${l.item_id}`}</td>
                                              <td className="py-1 text-slate-500">
                                                {[l.size, l.width, l.color].filter(Boolean).join(' / ')}
                                              </td>
                                              <td className="py-1 text-right text-slate-700">{l.qty?.toFixed(0) ?? '—'}</td>
                                              <td className="py-1 text-right text-slate-500">{l.qty_received?.toFixed(0) ?? '0'}</td>
                                              <td className={`py-1 text-right font-medium ${(l.qty_open ?? 0) > 0 ? 'text-blue-600' : 'text-slate-400'}`}>{l.qty_open?.toFixed(0) ?? '—'}</td>
                                              <td className="py-1 text-right font-mono text-slate-600">{l.unit_cost != null ? fmtDec(l.unit_cost) : '—'}</td>
                                              <td className="py-1 text-right font-mono text-slate-700">{l.extended_cost != null ? fmt(l.extended_cost) : '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      <p className="text-[10px] text-slate-400 mt-2">{lines.lines.length} line{lines.lines.length === 1 ? '' : 's'} loaded.</p>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
                <p className="text-[10px] text-slate-400">
                  <span className="mr-3">Sorted newest first.</span>
                  <span className="inline-flex items-center gap-1 mr-3"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> ≤7d</span>
                  <span className="inline-flex items-center gap-1 mr-3"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> 8-30d</span>
                  <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500" /> 30d+ (review or cancel)</span>
                </p>
                <button
                  type="button"
                  onClick={() => { setOrderModalVendor(null); setExpandedOrderId(null); }}
                  className="px-4 py-1.5 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Low-stock vendor contact popup ── */}
      {lowStockContactBrand && (() => {
        const info = VENDOR_CONTACTS[lowStockContactBrand.toUpperCase()] ?? VENDOR_CONTACTS[lowStockContactBrand];
        // Also check vendor card overrides — find the vendor by matching name
        const overrideEntry = Object.entries(vendorOverrides).find(([, ov]) =>
          (ov.displayName ?? '').toUpperCase() === lowStockContactBrand.toUpperCase()
        );
        const ov = overrideEntry ? overrideEntry[1] : {};
        const phone   = ov.phone   ?? info?.phone;
        const email   = ov.email   ?? info?.email;
        const website = ov.website ?? info?.website;
        const repName  = ov.repName  ?? info?.rep?.name;
        const repPhone = ov.repPhone ?? info?.rep?.phone;
        const repEmail = ov.repEmail ?? info?.rep?.email;
        const repTitle = ov.repTitle;
        const hasRep = repName || repPhone || repEmail;
        const hasAny = phone || email || website || hasRep;
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="low-stock-contact-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
            onClick={(e) => { if (e.target === e.currentTarget) setLowStockContactBrand(null); }}
          >
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
              {/* Header */}
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
                <div>
                  <h3 id="low-stock-contact-title" className="text-base font-semibold text-slate-900">{lowStockContactBrand}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Vendor contact info</p>
                </div>
                <button
                  type="button"
                  onClick={() => setLowStockContactBrand(null)}
                  aria-label="Close"
                  className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                >×</button>
              </div>

              {/* Body */}
              <div className="px-5 py-4 space-y-3">
                {!hasAny && (
                  <p className="text-sm text-slate-400 italic">No contact info on file for this vendor.</p>
                )}
                {phone && (
                  <div className="flex items-center gap-3">
                    <span className="text-base">📞</span>
                    <div>
                      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Phone</p>
                      <a href={`tel:${phone.replace(/\D/g,'')}`} className="text-sm text-blue-600 hover:underline font-medium">{phone}</a>
                    </div>
                  </div>
                )}
                {email && (
                  <div className="flex items-center gap-3">
                    <span className="text-base">✉</span>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Email</p>
                      <a href={`mailto:${email}`} className="text-sm text-blue-600 hover:underline truncate block">{email}</a>
                    </div>
                  </div>
                )}
                {website && (
                  <div className="flex items-center gap-3">
                    <span className="text-base">🌐</span>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Website</p>
                      <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" className="text-sm text-slate-600 hover:underline truncate block">{website.replace('https://','').replace('www.','')}</a>
                    </div>
                  </div>
                )}
                {hasRep && (
                  <div className="pt-2 mt-2 border-t border-slate-100 space-y-2">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Sales Rep</p>
                    {repName && (
                      <p className="text-sm font-medium text-slate-800">
                        {repName}{repTitle && <span className="font-normal text-slate-400"> — {repTitle}</span>}
                      </p>
                    )}
                    {repPhone && (
                      <div className="flex items-center gap-3">
                        <span className="text-base">📞</span>
                        <a href={`tel:${repPhone.replace(/\D/g,'')}`} className="text-sm text-blue-600 hover:underline">{repPhone}</a>
                      </div>
                    )}
                    {repEmail && (
                      <div className="flex items-center gap-3">
                        <span className="text-base">✉</span>
                        <a href={`mailto:${repEmail}`} className="text-sm text-blue-600 hover:underline truncate">{repEmail}</a>
                      </div>
                    )}
                    {info?.rep?.account && (
                      <p className="text-xs text-slate-500">Account # {info.rep.account}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-3 border-t border-slate-100 flex justify-end">
                <button
                  type="button"
                  onClick={() => setLowStockContactBrand(null)}
                  className="px-4 py-1.5 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Sales AI Chatbot ── */}
      <SalesChat />
    </div>
  );
}

// ── Utility components ────────────────────────────────────────────────

// ── KPI metric card with vs-last-year comparison ──────────────────────
function KpiCard({
  label,
  current,
  ly,
  formatVal = (n) => fmtDec(n),
  sub,
  subLy,
  onClick,
}: {
  label: string;
  current: number;
  ly?: number;
  formatVal?: (n: number) => string;
  sub?: string;
  subLy?: string;
  onClick?: () => void;
}) {
  const pctChange = ly != null && ly !== 0 ? ((current - ly) / ly) * 100 : null;
  const up = pctChange != null && pctChange >= 0;

  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-2 ${onClick ? 'cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all' : ''}`}
      onClick={onClick}
      title={onClick ? 'Click for details' : undefined}
    >
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide flex items-center gap-1">
        {label}
        {onClick && <span className="text-[9px] text-blue-400 font-normal normal-case">▸ details</span>}
      </p>
      <p className="text-2xl font-bold text-slate-900 leading-none">{formatVal(current)}</p>
      {ly != null && (
        <p className="text-xs text-slate-400">vs. <span className="text-slate-500 font-medium">{formatVal(ly)}</span></p>
      )}
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
      {subLy && <p className="text-[10px] text-slate-300">LY: {subLy}</p>}
      {pctChange != null && (
        <span className={`inline-flex items-center gap-1 self-start text-xs font-semibold px-2 py-0.5 rounded-full ${up ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
          {up ? '▲' : '▼'} {Math.abs(pctChange).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

function KpiGrid({
  data,
  reportingData,
  filterStart,
  filterEnd,
}: {
  data: DashboardResponse;
  reportingData: ReportingResponse | null;
  filterStart: string;
  filterEnd: string;
}) {
  const ly = data.lastYear;
  const [drilldown, setDrilldown] = useState<'avg_ticket' | 'tickets' | 'units' | null>(null);

  // ── Net sales from reporting dailyRows for the selected range ────
  const netForRange = useMemo(() => {
    if (!reportingData?.dailyRows || reportingData.dailyRows.length === 0) return null;
    const rows = reportingData.dailyRows.filter((r) => {
      const d = String(r['date.date'] ?? '');
      return d >= filterStart && d <= filterEnd;
    });
    if (rows.length === 0) return null;
    return {
      netSales: rows.reduce((s, r) => s + ((r['source_sales.net_sales'] as number) ?? 0), 0),
      transactions: rows.reduce((s, r) => s + ((r['source_sales.transaction_count'] as number) ?? 0), 0),
      rows,
    };
  }, [reportingData, filterStart, filterEnd]);

  // Primary amounts
  const primaryGross = data.selectedRange ?? data.today;
  const primaryAmount = netForRange?.netSales ?? primaryGross.totalAmount;
  const primaryTickets = netForRange?.transactions ?? primaryGross.ticketCount;

  // LY
  const lyPrimary = ly?.selectedRange ?? ly?.today;
  const lyAmount  = lyPrimary?.totalAmount ?? 0;
  const lyTickets = lyPrimary?.ticketCount ?? 0;

  const avgTicket   = primaryTickets > 0 ? primaryAmount / primaryTickets : 0;
  const lyAvgTicket = lyTickets > 0 ? lyAmount / lyTickets : 0;

  const estUnits      = primaryTickets * 1.5;
  const lyEstUnits    = lyTickets * 1.5;
  const unitsPerTxn   = 1.5;
  const lyUnitsPerTxn = 1.5;

  // YTD net from reporting summary
  const ytdNet        = reportingData?.summary?.totalNetSales ?? data.yearToDate.totalAmount;
  const ytdTickets    = reportingData?.summary?.totalTransactions ?? data.yearToDate.ticketCount;
  const lyYtdAmount   = ly?.yearToDate.totalAmount ?? 0;
  const lyYtdTickets  = ly?.yearToDate.ticketCount ?? 0;

  // Net Returns from reporting returnRows
  const netReturns = useMemo(() => {
    if (!reportingData?.returnRows) return null;
    const rows = reportingData.returnRows.filter(() => {
      // Filter to selected range if possible — returnRows are YTD so we can't
      // filter by date, but we can show the total and note it's YTD
      return true;
    });
    const total = rows.reduce((s, r) => s + Math.abs((r['source_sales.gross_returns'] as number) ?? 0), 0);
    return { total: Math.round(total * 100) / 100, byBrand: rows };
  }, [reportingData]);

  const rangeLabel = filterStart && filterEnd
    ? `${new Date(filterStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(filterEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'Selected Period';
  const netLabel = netForRange ? rangeLabel : `${rangeLabel} (gross)`;

  // Daily rows for the selected range (for drill-down)
  const rangeRows = netForRange?.rows ?? [];

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Sales vs. Last Year"     current={primaryAmount}  ly={lyAmount > 0 ? lyAmount : undefined}     formatVal={fmtDec} sub={netLabel} />
        <KpiCard label="Avg Transaction Value"   current={avgTicket}      ly={lyAvgTicket > 0 ? lyAvgTicket : undefined} formatVal={fmtDec}
          onClick={rangeRows.length > 0 ? () => setDrilldown('avg_ticket') : undefined} />
        <KpiCard label="# of Tickets"            current={primaryTickets} ly={lyTickets > 0 ? lyTickets : undefined}    formatVal={(n) => n.toFixed(0)}
          onClick={rangeRows.length > 0 ? () => setDrilldown('tickets') : undefined} />
        <KpiCard label="Total Units Sold"        current={estUnits}       ly={lyEstUnits > 0 ? lyEstUnits : undefined}  formatVal={(n) => n.toFixed(0)} sub="est. (1.5× tickets)"
          onClick={rangeRows.length > 0 ? () => setDrilldown('units') : undefined} />
        <KpiCard label="Units / Transaction"     current={unitsPerTxn}    ly={lyUnitsPerTxn}                            formatVal={(n) => n.toFixed(2)} />
        <KpiCard label="Net Returns (YTD)"
          current={netReturns?.total ?? 0}
          ly={undefined}
          formatVal={fmtDec}
          sub={netReturns == null ? 'not yet synced' : netReturns.total === 0 ? 'no returns this year' : undefined} />
        <KpiCard label="Year to Date (Net)"      current={ytdNet}         ly={lyYtdAmount > 0 ? lyYtdAmount : undefined} formatVal={fmt}
          sub={`${ytdTickets.toLocaleString()} tickets`}
          subLy={ly ? `${lyYtdTickets.toLocaleString()} tickets` : undefined} />
      </div>

      {/* ── Drill-down modal ── */}
      {drilldown && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setDrilldown(null); }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {drilldown === 'avg_ticket' && 'Avg Transaction Value — Daily Breakdown'}
                  {drilldown === 'tickets' && '# of Tickets — Daily Breakdown'}
                  {drilldown === 'units' && 'Total Units Sold — Daily Breakdown'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{rangeLabel} · from Heartland Reporting Analyzer</p>
              </div>
              <button onClick={() => setDrilldown(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {rangeRows.length === 0 ? (
                <p className="p-6 text-sm text-slate-400 text-center">No data for this date range in the reporting cache.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Date</th>
                      <th className="text-right px-4 py-2.5 text-slate-500 font-medium">Net Sales</th>
                      <th className="text-right px-4 py-2.5 text-slate-500 font-medium">Tickets</th>
                      {drilldown === 'avg_ticket' && <th className="text-right px-4 py-2.5 text-slate-500 font-medium">Avg Ticket</th>}
                      {drilldown === 'units' && <th className="text-right px-4 py-2.5 text-slate-500 font-medium">Est. Units</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {[...rangeRows]
                      .sort((a, b) => String(b['date.date'] ?? '').localeCompare(String(a['date.date'] ?? '')))
                      .map((r, i) => {
                        const date = String(r['date.date'] ?? '');
                        const sales = (r['source_sales.net_sales'] as number) ?? 0;
                        const txns = (r['source_sales.transaction_count'] as number) ?? 0;
                        const avg = txns > 0 ? sales / txns : 0;
                        const units = Math.round(txns * 1.5);
                        return (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="px-4 py-2 text-slate-700 font-medium">
                              {date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-slate-700">{fmtDec(sales)}</td>
                            <td className="px-4 py-2 text-right text-slate-600">{txns}</td>
                            {drilldown === 'avg_ticket' && (
                              <td className="px-4 py-2 text-right font-mono font-semibold text-blue-700">{fmtDec(avg)}</td>
                            )}
                            {drilldown === 'units' && (
                              <td className="px-4 py-2 text-right font-semibold text-blue-700">{units}</td>
                            )}
                          </tr>
                        );
                      })}
                  </tbody>
                  {/* Totals row */}
                  <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                    <tr>
                      <td className="px-4 py-2.5 text-xs font-semibold text-slate-700">Total</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-slate-900">{fmtDec(primaryAmount)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-900">{primaryTickets}</td>
                      {drilldown === 'avg_ticket' && (
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-blue-700">{fmtDec(avgTicket)}</td>
                      )}
                      {drilldown === 'units' && (
                        <td className="px-4 py-2.5 text-right font-semibold text-blue-700">{Math.round(estUnits)}</td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 flex justify-between items-center">
              <p className="text-[10px] text-slate-400">
                {drilldown === 'units' ? 'Units estimated at 1.5× ticket count — exact unit data requires line-item sync.' : 'Net sales from Heartland Reporting Analyzer (post-discount, post-return).'}
              </p>
              <button onClick={() => setDrilldown(null)} className="px-3 py-1.5 text-xs rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Alerts panel ──────────────────────────────────────────────────────
function AlertsPanel({
  alerts,
  onNavigate,
}: {
  alerts?: DashboardResponse['alerts'];
  onNavigate: (tab: Tab) => void;
}) {
  const items: Array<{ msg: string; tab: Tab }> = [];
  if (alerts?.openOrders && alerts.openOrders > 0) {
    items.push({ msg: `There are ${alerts.openOrders} overdue purchase orders to be received.`, tab: 'purchasing' });
  }
  if (alerts?.lowStock && alerts.lowStock > 0) {
    items.push({ msg: `There are ${alerts.lowStock} items with low stock (≤3 units).`, tab: 'inventory' });
  }

  return (
    <div className={`rounded-xl border p-5 ${items.length > 0 ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className={`w-4 h-4 ${items.length > 0 ? 'text-red-500' : 'text-slate-400'}`} />
        <h3 className={`text-sm font-semibold ${items.length > 0 ? 'text-red-700' : 'text-slate-700'}`}>Alerts</h3>
        {items.length > 0 && (
          <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">No alerts — everything looks good.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i}>
              <button
                onClick={() => onNavigate(item.tab)}
                className="w-full flex items-start gap-2 text-left group"
              >
                <span className="mt-0.5 flex-shrink-0 w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5" />
                <span className="text-xs text-red-700 group-hover:underline leading-snug">{item.msg}</span>
                <span className="ml-auto text-red-400 group-hover:text-red-600 flex-shrink-0">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Action Items panel — multi-column with assignees ─────────────────
interface DashNote {
  id: string;
  text: string;
  createdAt: string;
  done: boolean;
  assignee?: string; // column id
}

interface ActionColumn {
  id: string;
  name: string;
}

const NOTES_KEY = 'foot-solutions:dash-notes';
const COLUMNS_KEY = 'foot-solutions:action-columns';

const DEFAULT_COLUMNS: ActionColumn[] = [
  { id: 'justin', name: 'Justin' },
  { id: 'nancy',  name: 'Nancy'  },
];

// ── Lifted out of NotesPanel so React never remounts them on re-render ──

interface NoteItemProps {
  n: DashNote;
  columns: ActionColumn[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onReassign: (id: string, assignee: string | undefined) => void;
}
function NoteItem({ n, columns, onToggle, onRemove, onReassign }: NoteItemProps) {
  const dateStamp = new Date(n.createdAt).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return (
    <li className={`flex items-start gap-2 bg-white rounded-lg px-2.5 py-2 border shadow-sm ${n.done ? 'opacity-50 border-slate-100' : 'border-amber-200'}`}>
      <input type="checkbox" checked={n.done} onChange={() => onToggle(n.id)}
        className="mt-0.5 flex-shrink-0 accent-amber-500 cursor-pointer" aria-label={n.done ? 'Unmark done' : 'Mark done'} />
      <div className="flex-1 min-w-0">
        <span className={`text-xs leading-snug ${n.done ? 'line-through text-slate-400' : 'text-slate-700'}`}>{n.text}</span>
        <p className="text-[9px] text-slate-400 mt-0.5">{dateStamp}</p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <select
          value={n.assignee ?? ''}
          onChange={(e) => onReassign(n.id, e.target.value || undefined)}
          className="text-[10px] border border-slate-200 rounded px-1 py-0.5 text-slate-500 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400 cursor-pointer"
          aria-label="Reassign"
          title="Move to column"
        >
          <option value="">Unassigned</option>
          {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={() => onRemove(n.id)}
          className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-0.5 transition-colors"
          aria-label="Delete" title="Delete">
          <X className="w-3 h-3" />
        </button>
      </div>
    </li>
  );
}

interface ColumnInputProps {
  colId?: string;
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
}
function ColumnInput({ value, onChange, onAdd }: ColumnInputProps) {
  return (
    <div className="flex gap-1.5 mt-2 min-w-0">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
        placeholder="Add item… (Enter)"
        className="flex-1 min-w-0 text-[11px] rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400 placeholder-slate-400"
      />
      <button onClick={onAdd} disabled={!value.trim()}
        className="flex-shrink-0 px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-amber-400 text-white hover:bg-amber-500 disabled:opacity-40 transition">
        Add
      </button>
    </div>
  );
}

function NotesPanel() {
  const [notes, setNotes] = useState<DashNote[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(NOTES_KEY) ?? '[]') as DashNote[]; }
    catch { return []; }
  });
  const [columns, setColumns] = useState<ActionColumn[]>(() => {
    try {
      const saved = window.localStorage.getItem(COLUMNS_KEY);
      return saved ? JSON.parse(saved) as ActionColumn[] : DEFAULT_COLUMNS;
    } catch { return DEFAULT_COLUMNS; }
  });

  // Per-column draft inputs
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Which column name is being edited
  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState('');
  // Unassigned draft (no column selected)
  const [unassignedDraft, setUnassignedDraft] = useState('');

  function persistNotes(next: DashNote[]) {
    setNotes(next);
    try { window.localStorage.setItem(NOTES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function persistColumns(next: ActionColumn[]) {
    setColumns(next);
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function addNote(assignee?: string) {
    const text = (assignee ? drafts[assignee] : unassignedDraft)?.trim();
    if (!text) return;
    persistNotes([{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), done: false, assignee }, ...notes]);
    if (assignee) setDrafts((d) => ({ ...d, [assignee]: '' }));
    else setUnassignedDraft('');
  }

  function toggleDone(id: string) {
    persistNotes(notes.map((n) => n.id === id ? { ...n, done: !n.done } : n));
  }

  function removeNote(id: string) {
    persistNotes(notes.filter((n) => n.id !== id));
  }

  function reassign(id: string, assignee: string | undefined) {
    persistNotes(notes.map((n) => n.id === id ? { ...n, assignee } : n));
  }

  function addColumn() {
    const id = crypto.randomUUID();
    persistColumns([...columns, { id, name: 'New Person' }]);
    setEditingCol(id);
    setEditingColName('New Person');
  }

  function removeColumn(colId: string) {
    if (!window.confirm('Remove this column? Notes assigned to it will move to Unassigned.')) return;
    persistColumns(columns.filter((c) => c.id !== colId));
    persistNotes(notes.map((n) => n.assignee === colId ? { ...n, assignee: undefined } : n));
  }

  function saveColName(colId: string) {
    const name = editingColName.trim();
    if (!name) return;
    persistColumns(columns.map((c) => c.id === colId ? { ...c, name } : c));
    setEditingCol(null);
  }

  // Unassigned notes
  const unassigned = notes.filter((n) => !n.assignee || !columns.find((c) => c.id === n.assignee));
  const totalActive = notes.filter((n) => !n.done).length;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <StickyNote className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-amber-800">Action Items</h3>
        {totalActive > 0 && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold text-white">
            {totalActive}
          </span>
        )}
        <button onClick={addColumn}
          className="ml-auto text-[11px] text-amber-600 hover:text-amber-800 border border-amber-300 rounded px-2 py-0.5 hover:bg-amber-100 transition"
          title="Add a new person column">
          + Add column
        </button>
      </div>

      {/* Columns */}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(180px, 1fr))` }}>
        {columns.map((col) => {
          const colNotes = notes.filter((n) => n.assignee === col.id);
          const colActive = colNotes.filter((n) => !n.done).length;
          return (
            <div key={col.id} className="bg-white/60 rounded-lg border border-amber-200 p-2.5 flex flex-col gap-1.5 min-w-0 overflow-hidden">
              {/* Column header */}
              <div className="flex items-center gap-1 mb-1">
                {editingCol === col.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={editingColName}
                    onChange={(e) => setEditingColName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveColName(col.id); if (e.key === 'Escape') setEditingCol(null); }}
                    onBlur={() => saveColName(col.id)}
                    className="flex-1 text-xs font-semibold border-b border-amber-400 bg-transparent focus:outline-none text-amber-900"
                  />
                ) : (
                  <button
                    onClick={() => { setEditingCol(col.id); setEditingColName(col.name); }}
                    className="flex-1 text-xs font-semibold text-amber-900 text-left hover:text-amber-600 transition"
                    title="Click to rename"
                  >
                    {col.name}
                    {colActive > 0 && <span className="ml-1.5 text-[10px] font-bold text-amber-500">({colActive})</span>}
                  </button>
                )}
                <button onClick={() => removeColumn(col.id)}
                  className="flex-shrink-0 text-slate-300 hover:text-red-400 transition-colors" title="Remove column">
                  <X className="w-3 h-3" />
                </button>
              </div>

              {/* Notes in this column */}
              {colNotes.length > 0 ? (
                <ul className="space-y-1.5">
                  {colNotes.map((n) => (
                    <NoteItem key={n.id} n={n} columns={columns} onToggle={toggleDone} onRemove={removeNote} onReassign={reassign} />
                  ))}
                </ul>
              ) : (
                <p className="text-[10px] text-slate-400 italic px-1">No items yet</p>
              )}

              <ColumnInput
                colId={col.id}
                value={drafts[col.id] ?? ''}
                onChange={(v) => setDrafts((d) => ({ ...d, [col.id]: v }))}
                onAdd={() => addNote(col.id)}
              />
            </div>
          );
        })}
      </div>

      {/* Unassigned */}
      {unassigned.length > 0 && (
        <div className="bg-white/40 rounded-lg border border-dashed border-amber-200 p-2.5">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Unassigned</p>
          <ul className="space-y-1.5">
            {unassigned.map((n) => (
              <NoteItem key={n.id} n={n} columns={columns} onToggle={toggleDone} onRemove={removeNote} onReassign={reassign} />
            ))}
          </ul>
        </div>
      )}

      {/* Global add (unassigned) */}
      <ColumnInput
        value={unassignedDraft}
        onChange={setUnassignedDraft}
        onAdd={() => addNote(undefined)}
      />
    </div>
  );
}

// ── Net Sales by Hour / By Day chart ─────────────────────────────────
function NetSalesByHourChart({
  hourly,
  dailyTrend,
}: {
  hourly?: DashboardResponse['hourly'];
  dailyTrend?: AnalyticsResponse['dailyTrend'];
}) {
  type ChartMode = 'hour' | 'day';
  type SeriesView = 'both' | 'current' | 'lastYear';

  const [mode, setMode] = useState<ChartMode>('hour');
  const [view, setView] = useState<SeriesView>('both');

  const hourLabels = ['12am','1am','2am','3am','4am','5am','6am','7am','8am','9am','10am','11am',
    '12pm','1pm','2pm','3pm','4pm','5pm','6pm','7pm','8pm','9pm','10pm','11pm'];

  const W = 560, H = 200;
  const pad = { top: 20, right: 12, bottom: 36, left: 44 };
  const iW = W - pad.left - pad.right;
  const iH = H - pad.top - pad.bottom;

  // ── Hour mode data ────────────────────────────────────────────────
  const curHour = hourly?.today ?? (Array(24).fill(0) as number[]);
  const lyHour  = hourly?.lastYear ?? (Array(24).fill(0) as number[]);

  // ── Day mode data ─────────────────────────────────────────────────
  // Use analytics daily trend for current; no LY daily data available so hide LY toggle in day mode
  const dayData = useMemo(() => {
    if (!dailyTrend || dailyTrend.length === 0) return [];
    return [...dailyTrend].sort((a, b) => a.date.localeCompare(b.date));
  }, [dailyTrend]);

  // Active series arrays
  const current = mode === 'hour' ? curHour : dayData.map((d) => d.amount);
  const lastYearVals = mode === 'hour' ? lyHour : [];
  const hasLY = mode === 'hour';

  const maxVal = Math.max(...current, ...(hasLY ? lastYearVals : []), 1);
  const niceMax = (() => {
    if (maxVal <= 100)   return Math.ceil(maxVal / 25) * 25;
    if (maxVal <= 500)   return Math.ceil(maxVal / 100) * 100;
    if (maxVal <= 2000)  return Math.ceil(maxVal / 250) * 250;
    if (maxVal <= 10000) return Math.ceil(maxVal / 1000) * 1000;
    return Math.ceil(maxVal / 2000) * 2000;
  })();

  const n = current.length || 1;

  function toPoints(vals: number[]) {
    return vals.map((v, i) => ({
      x: pad.left + (vals.length === 1 ? iW / 2 : (i / (vals.length - 1)) * iW),
      y: pad.top + iH - (v / niceMax) * iH,
    }));
  }

  function areaPath(pts: Array<{ x: number; y: number }>) {
    if (pts.length === 0) return '';
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const base = `L ${pts[pts.length - 1]!.x.toFixed(1)},${(pad.top + iH).toFixed(1)} L ${pts[0]!.x.toFixed(1)},${(pad.top + iH).toFixed(1)} Z`;
    return `${line} ${base}`;
  }

  const curPts = toPoints(current);
  const lyPts  = toPoints(lastYearVals);

  const yTicks = [0, niceMax * 0.5, niceMax];

  // X ticks — up to 6 evenly spaced
  const xTickCount = Math.min(6, n);
  const xTicks = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i / Math.max(xTickCount - 1, 1)) * (n - 1))
  );

  function xLabel(i: number): string {
    if (mode === 'hour') return hourLabels[i] ?? '';
    const d = dayData[i];
    if (!d) return '';
    return new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  }

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Reset hover when mode changes
  const prevMode = useMemo(() => mode, [mode]);
  if (prevMode !== mode && hoverIdx !== null) setHoverIdx(null);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      {/* Header row: title + By Hr / By Day toggle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">Net Sales</h3>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            onClick={() => { setMode('hour'); setHoverIdx(null); }}
            className={`px-3 py-1.5 transition ${mode === 'hour' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            By Hr
          </button>
          <button
            onClick={() => { setMode('day'); setHoverIdx(null); setView('current'); }}
            className={`px-3 py-1.5 border-l border-slate-200 transition ${mode === 'day' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            By Day
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="relative">
        {mode === 'day' && dayData.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-10">No daily data — Analytics tab loads this automatically.</p>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            preserveAspectRatio="xMidYMid meet"
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id="hourCurGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1e40af" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#1e40af" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="hourLyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a855f7" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#a855f7" stopOpacity="0.05" />
              </linearGradient>
            </defs>

            {/* Y gridlines */}
            {yTicks.map((t, i) => {
              const y = pad.top + iH - (t / niceMax) * iH;
              return (
                <g key={i}>
                  <line x1={pad.left} x2={pad.left + iW} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray={i === 0 ? '0' : '3,3'} />
                  <text x={pad.left - 6} y={y + 4} textAnchor="end" fontSize={9} fill="#94a3b8" fontFamily="monospace">
                    {t >= 1000 ? `${(t / 1000).toFixed(0)}k` : t}
                  </text>
                </g>
              );
            })}

            {/* X axis */}
            <line x1={pad.left} x2={pad.left + iW} y1={pad.top + iH} y2={pad.top + iH} stroke="#cbd5e1" strokeWidth={1} />
            {xTicks.map((i) => {
              const x = pad.left + (n === 1 ? iW / 2 : (i / (n - 1)) * iW);
              return (
                <text key={i} x={x} y={pad.top + iH + 14} textAnchor="middle" fontSize={9} fill="#94a3b8">
                  {xLabel(i)}
                </text>
              );
            })}

            {/* Last year area (hour mode only) */}
            {hasLY && (view === 'both' || view === 'lastYear') && lyPts.length > 0 && (
              <>
                <path d={areaPath(lyPts)} fill="url(#hourLyGrad)" />
                <path d={lyPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
                  fill="none" stroke="#a855f7" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}

            {/* Current area */}
            {(view === 'both' || view === 'current') && curPts.length > 0 && (
              <>
                <path d={areaPath(curPts)} fill="url(#hourCurGrad)" />
                <path d={curPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
                  fill="none" stroke="#1e40af" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}

            {/* Hover crosshair + tooltip */}
            {hoverIdx !== null && (() => {
              const x = pad.left + (n === 1 ? iW / 2 : (hoverIdx / (n - 1)) * iW);
              const curVal = current[hoverIdx] ?? 0;
              const lyVal  = hasLY ? (lastYearVals[hoverIdx] ?? 0) : null;
              const label  = xLabel(hoverIdx);
              const ttW = 140, ttH = hasLY && lyVal !== null ? 56 : 42;
              const ttX = x + 10 + ttW > W ? x - ttW - 10 : x + 10;
              const ttY = pad.top;
              return (
                <g pointerEvents="none">
                  <line x1={x} x2={x} y1={pad.top} y2={pad.top + iH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" />
                  <rect x={ttX} y={ttY} width={ttW} height={ttH} rx={5} fill="#0f172a" opacity={0.92} />
                  <text x={ttX + 8} y={ttY + 15} fontSize={10} fill="#cbd5e1">{label}</text>
                  <text x={ttX + 8} y={ttY + 30} fontSize={10} fill="#60a5fa">Current: {fmtDec(curVal)}</text>
                  {hasLY && lyVal !== null && (
                    <text x={ttX + 8} y={ttY + 44} fontSize={10} fill="#c084fc">Last yr: {fmtDec(lyVal)}</text>
                  )}
                </g>
              );
            })()}

            {/* Invisible hover zones */}
            {Array.from({ length: n }, (_, i) => {
              const x = pad.left + (n === 1 ? iW / 2 : (i / (n - 1)) * iW);
              const slotW = n === 1 ? iW : iW / (n - 1);
              return (
                <rect
                  key={i}
                  x={x - slotW / 2}
                  y={pad.top}
                  width={slotW}
                  height={iH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)}
                  style={{ cursor: 'crosshair' }}
                />
              );
            })}
          </svg>
        )}
      </div>

      {/* Current / Last Year toggle — only shown in hour mode */}
      {mode === 'hour' && (
        <div className="flex justify-center gap-3 mt-3">
          <button
            onClick={() => setView(view === 'current' ? 'both' : 'current')}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold transition ${view === 'lastYear' ? 'bg-slate-100 text-slate-400' : 'bg-blue-700 text-white shadow-sm'}`}
          >
            Current
          </button>
          <button
            onClick={() => setView(view === 'lastYear' ? 'both' : 'lastYear')}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold transition ${view === 'current' ? 'bg-slate-100 text-slate-400' : 'bg-purple-600 text-white shadow-sm'}`}
          >
            Last Year
          </button>
        </div>
      )}
    </div>
  );
}

// ── Top Performers panel (brands by net sales from reporting data) ────
function TopPerformersPanel({
  reportingData,
  analyticsData,
}: {
  reportingData?: ReportingResponse | null;
  analyticsData?: AnalyticsResponse | null;
}) {
  type SortKey = 'netSales' | 'qty';
  const [sortBy, setSortBy] = useState<SortKey>('netSales');

  // Build rows from reporting brand data (YTD net sales + qty)
  const rows = useMemo(() => {
    if (!reportingData?.brandRows) return [];
    return reportingData.brandRows
      .filter((r) => ((r['source_sales.net_sales'] as number) ?? 0) > 0)
      .map((r) => ({
        brand: String(r['item.custom@brand'] ?? '(unknown)'),
        netSales: (r['source_sales.net_sales'] as number) ?? 0,
        qty: (r['source_sales.net_qty_sold'] as number) ?? 0,
        transactions: (r['source_sales.transaction_count'] as number) ?? 0,
      }))
      .sort((a, b) => sortBy === 'netSales' ? b.netSales - a.netSales : b.qty - a.qty)
      .slice(0, 10);
  }, [reportingData, sortBy]);

  // Top staff from analytics (today's bySalesRep)
  const topStaff = analyticsData?.bySalesRep?.[0];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4">
      {/* Top staff performer banner */}
      {topStaff && (
        <div className="flex items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
          <Trophy className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div>
            <p className="text-xs text-amber-600 font-medium uppercase tracking-wide">Top Performer Today</p>
            <p className="text-sm font-bold text-slate-900">{topStaff.name}</p>
          </div>
          <p className="ml-auto text-sm font-bold text-amber-700">{fmt(topStaff.amount)}</p>
        </div>
      )}

      {/* Brand table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Top Performers</h3>
          <p className="text-[10px] text-slate-400">YTD · from Reporting</p>
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-slate-400 py-4 text-center">Load the Reporting tab first to populate brand data.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 text-slate-500 font-semibold uppercase tracking-wide text-[10px]">Vendor</th>
                <th
                  className={`text-right py-2 font-semibold uppercase tracking-wide text-[10px] cursor-pointer select-none ${sortBy === 'qty' ? 'text-blue-600' : 'text-slate-500'}`}
                  onClick={() => setSortBy('qty')}
                >
                  QTY {sortBy === 'qty' && '↓'}
                </th>
                <th
                  className={`text-right py-2 font-semibold uppercase tracking-wide text-[10px] cursor-pointer select-none ${sortBy === 'netSales' ? 'text-blue-600' : 'text-slate-500'}`}
                  onClick={() => setSortBy('netSales')}
                >
                  Net Sales {sortBy === 'netSales' && '↓'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r, i) => (
                <tr key={r.brand} className={i === 0 ? 'bg-amber-50' : 'hover:bg-slate-50'}>
                  <td className="py-2 font-medium text-slate-800">
                    {i === 0 && <span className="mr-1 text-amber-500">★</span>}
                    {r.brand}
                  </td>
                  <td className="py-2 text-right text-slate-600">{r.qty.toLocaleString()}</td>
                  <td className="py-2 text-right font-semibold text-slate-800">{fmt(r.netSales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Copy PO number button ─────────────────────────────────────────────
function CopyPoButton({ po }: { po: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    void navigator.clipboard.writeText(po).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      onClick={handleCopy}
      title={`Copy PO# ${po}`}
      className="flex-shrink-0 text-slate-300 hover:text-blue-500 transition-colors"
      aria-label={`Copy PO number ${po}`}
    >
      {copied
        ? <svg className="w-3.5 h-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

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

function LightbulbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" /><path d="M10 22h4" />
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
