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
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import Spinner from '../components/Spinner';
import CentralTimeBadge from '../components/CentralTimeBadge';
import { downloadCsvSections, stampedName, csvNum, type CsvSection } from '../lib/csv';

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
  'YALEET':           { phone: '516-465-6268', website: 'https://www.naot.com' },
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

type Tab = 'overview' | 'analytics' | 'inventory' | 'staff' | 'purchasing' | 'reporting' | 'insights';

// ── Main page ─────────────────────────────────────────────────────────

export default function SalesRevenue() {
  const [tab, setTab] = useState<Tab>('overview');
  const [analyticsDays, setAnalyticsDays] = useState(7);

  // Staff date selector — defaults to YTD (matches old behavior)
  type StaffPeriod = 'today' | '7d' | '30d' | 'monthly' | 'ytd' | 'custom';
  const [staffPeriod, setStaffPeriod] = useState<StaffPeriod>('ytd');
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
    enabled: tab === 'purchasing',
  });

  const reportingQ = useQuery<ReportingResponse>({
    queryKey: ['pos', 'reporting'],
    queryFn: () => api.get<ReportingResponse>('/pos/reporting').then((r) => r.data),
    staleTime: 30 * 60 * 1000,
    enabled: tab === 'reporting' || tab === 'insights',
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

  // Vendor account status — persisted in localStorage so it survives page refreshes
  const ACCOUNTS_KEY = 'foot-solutions:vendor-accounts';
  const DISCONTINUED_KEY = 'foot-solutions:vendor-discontinued';

  const [activeAccounts, setActiveAccounts] = useState<Set<string>>(() => {
    try {
      const saved = window.localStorage.getItem(ACCOUNTS_KEY);
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const [discontinuedVendors, setDiscontinuedVendors] = useState<Set<string>>(() => {
    try {
      const saved = window.localStorage.getItem(DISCONTINUED_KEY);
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  function handleVendorAccountToggle(key: string, vendorName: string, checked: boolean) {
    if (checked) {
      // Confirm before marking active
      if (!window.confirm(`Mark "${vendorName}" as having an active account?`)) return;
      setActiveAccounts((prev) => {
        const next = new Set(prev);
        next.add(key);
        try { window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
        return next;
      });
    } else {
      // Confirm before removing
      if (!window.confirm(`Remove the active account mark for "${vendorName}"?`)) return;
      setActiveAccounts((prev) => {
        const next = new Set(prev);
        next.delete(key);
        try { window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
        return next;
      });
    }
  }

  function handleDiscontinuedToggle(key: string, vendorName: string) {
    const isCurrentlyDiscontinued = discontinuedVendors.has(key);
    if (isCurrentlyDiscontinued) {
      if (!window.confirm(`Remove "will discontinue" flag from "${vendorName}"?`)) return;
      setDiscontinuedVendors((prev) => {
        const next = new Set(prev);
        next.delete(key);
        try { window.localStorage.setItem(DISCONTINUED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
        return next;
      });
    } else {
      if (!window.confirm(`Mark "${vendorName}" as will discontinue?`)) return;
      setDiscontinuedVendors((prev) => {
        const next = new Set(prev);
        next.add(key);
        try { window.localStorage.setItem(DISCONTINUED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
        return next;
      });
    }
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'overview', label: 'Overview', icon: TrendingUp },
    { id: 'analytics', label: 'Analytics', icon: BarChart3Icon },
    { id: 'insights', label: 'Insights', icon: LightbulbIcon },
    { id: 'inventory', label: 'Inventory', icon: Package },
    { id: 'staff', label: 'Staff', icon: Users },
    { id: 'purchasing', label: 'Purchasing', icon: ShoppingBag },
    { id: 'reporting', label: 'Reporting', icon: BarChart3Icon },
  ];

  function refetchCurrent() {
    if (tab === 'overview') void dashQ.refetch();
    if (tab === 'analytics') void analyticsQ.refetch();
    if (tab === 'inventory') void inventoryQ.refetch();
    if (tab === 'staff') void staffQ.refetch();
    if (tab === 'purchasing') void purchasingQ.refetch();
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
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <Link to="/" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors">
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
            {dashQ.isLoading && <LoadingState label="Loading sales data from Heartland…" />}
            {dashQ.isError && <ErrorState error={dashQ.error} />}
            {dashQ.data && (
              <>
                {/* Revenue goal tracker */}
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
                      const pacedTarget = goals.daily * (hoursElapsed / 10); // assume 10hr store day
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

                  {/* Low stock items */}
                  {d.lowStockItems && d.lowStockItems.length > 0 && (
                    <div className="bg-white rounded-lg border border-red-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
                        <Package className="w-4 h-4 text-red-500" /> Low Stock Alert (≤3 units)
                      </h3>
                      <p className="text-xs text-slate-500 mb-4">Items at Flower Mound with 3 or fewer units on hand. Consider reordering.</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th className="text-left py-2 text-slate-500 font-medium">SKU</th>
                              <th className="text-left py-2 text-slate-500 font-medium">Description</th>
                              <th className="text-left py-2 text-slate-500 font-medium">Brand</th>
                              <th className="text-right py-2 text-slate-500 font-medium">On Hand</th>
                              <th className="text-right py-2 text-slate-500 font-medium">Available</th>
                              <th className="text-right py-2 text-slate-500 font-medium">Price</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {d.lowStockItems.map((item) => (
                              <tr key={item.item_id}>
                                <td className="py-1.5 text-slate-500 font-mono">{item.sku}</td>
                                <td className="py-1.5 text-slate-700 max-w-[180px] truncate">{item.description}</td>
                                <td className="py-1.5 text-slate-500">{item.brand}</td>
                                <td className={`py-1.5 text-right font-medium ${item.qty_on_hand <= 1 ? 'text-red-600' : 'text-amber-600'}`}>{item.qty_on_hand}</td>
                                <td className="py-1.5 text-right text-slate-600">{item.qty_available}</td>
                                <td className="py-1.5 text-right text-slate-600">{fmtDec(item.price)}</td>
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
                { id: 'monthly', label: 'This month' },
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
              return (
                <>
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

              // Reorder alerts — from inventory data (only meaningful for current year)
              const lowStock = !usingPrior ? (inventoryQ.data?.lowStockItems ?? []) : [];

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

                  {/* Inventory Turn + Reorder Alerts */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Inventory turn */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Package className="w-4 h-4 text-slate-400" /> Inventory Turn Rate
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

                    {/* Reorder alerts */}
                    <div className="bg-white rounded-lg border border-slate-200 p-5">
                      <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
                        <Package className="w-4 h-4 text-red-400" /> Reorder Alerts
                      </h3>
                      <p className="text-xs text-slate-500 mb-3">Items at Flower Mound with ≤3 units. Tap a vendor name to call.</p>
                      {usingPrior ? (
                        <p className="text-sm text-slate-400 italic">Reorder alerts reflect current stock — not available for prior-year views.</p>
                      ) : lowStock.length === 0 ? (
                        <p className="text-sm text-slate-400 italic">No low-stock items — or inventory hasn't synced yet.</p>
                      ) : (
                        <div className="space-y-1.5 max-h-64 overflow-y-auto">
                          {lowStock.slice(0, 30).map((item) => {
                            const vendorInfo = VENDOR_CONTACTS[item.brand?.toUpperCase() ?? ''] ?? VENDOR_CONTACTS[item.brand ?? ''];
                            return (
                              <div key={item.item_id} className="flex items-start justify-between gap-2 text-xs py-1 border-b border-slate-50 last:border-0">
                                <div className="min-w-0">
                                  <p className="text-slate-800 font-medium truncate">{item.description}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {vendorInfo?.phone ? (
                                      <a href={`tel:${vendorInfo.phone.replace(/\D/g,'')}`} className="text-blue-600 hover:underline">
                                        {item.brand} · {vendorInfo.phone}
                                      </a>
                                    ) : (
                                      <span className="text-slate-400">{item.brand}</span>
                                    )}
                                  </div>
                                </div>
                                <span className={`flex-shrink-0 font-bold text-sm ${item.qty_on_hand <= 1 ? 'text-red-600' : 'text-amber-600'}`}>
                                  {item.qty_on_hand} left
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
          );
        })()}

        {/* ── PURCHASING TAB ── */}
        {tab === 'purchasing' && (
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
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <StatCard label="Vendors" value={d.vendorCount.toLocaleString()} sub="active suppliers" icon={ShoppingBag} color="blue" />
                    <StatCard label="Total Orders" value={d.totalOrders.toLocaleString()} sub="all time" icon={Package} color="green" />
                    <StatCard label="Open Orders" value={d.openOrderCount.toLocaleString()} sub="pending or open" icon={TrendingUp} color="amber" />
                  </div>

                  {/* Vendor directory with contact info */}
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
                          const key = `vendor-account:${v.id}`;
                          const hasAccount = activeAccounts.has(key);
                          const isDiscontinued = discontinuedVendors.has(key);
                          const ytdSales = brandSales[(v.name ?? '').toUpperCase()];
                          const rankRow = (d.vendorRank ?? []).find((r) => r.vendorId === v.id);
                          const openOrders = rankRow?.openOrders ?? 0;
                          const totalOrders = rankRow?.totalOrders ?? 0;
                          return (
                            <div
                              key={v.id}
                              className={`rounded-lg border p-3 transition ${
                                isDiscontinued
                                  ? 'border-amber-300 bg-amber-50'
                                  : hasAccount
                                    ? 'border-emerald-300 bg-emerald-50'
                                    : 'border-slate-100 bg-slate-50 hover:border-slate-300'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="min-w-0">
                                  <p className={`text-xs font-semibold ${isDiscontinued ? 'text-amber-900' : hasAccount ? 'text-emerald-900' : 'text-slate-900'}`}>
                                    {v.name ?? `Vendor ${v.id}`}
                                    {isDiscontinued && <span className="ml-1.5 text-[10px] font-medium text-amber-700 bg-amber-100 px-1 py-0.5 rounded">Discontinuing</span>}
                                  </p>
                                  {ytdSales != null && ytdSales > 0 && (
                                    <p className="text-[10px] text-slate-400">{fmt(ytdSales)} YTD</p>
                                  )}
                                  {(totalOrders > 0 || openOrders > 0) && (
                                    <p className="text-[10px] text-slate-400">
                                      {openOrders > 0 && (
                                        <button
                                          type="button"
                                          onClick={() => setOrderModalVendor({ id: v.id, name: v.name ?? `Vendor ${v.id}` })}
                                          className="text-blue-600 font-medium hover:underline focus:outline-none focus-visible:underline"
                                        >
                                          {openOrders} open ▸
                                        </button>
                                      )}
                                      {openOrders > 0 && totalOrders > 0 && <span> · </span>}
                                      {totalOrders > 0 && <span>{totalOrders} total order{totalOrders === 1 ? '' : 's'}</span>}
                                    </p>
                                  )}
                                </div>
                                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                  <label className="flex items-center gap-1 cursor-pointer" title="Check to mark account active">
                                    <input
                                      type="checkbox"
                                      checked={hasAccount}
                                      onChange={(e) => handleVendorAccountToggle(key, v.name ?? `Vendor ${v.id}`, e.target.checked)}
                                      className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                                    />
                                    <span className={`text-[10px] ${hasAccount ? 'text-emerald-700 font-medium' : 'text-slate-400'}`}>
                                      {hasAccount ? 'Active' : 'Account?'}
                                    </span>
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => handleDiscontinuedToggle(key, v.name ?? `Vendor ${v.id}`)}
                                    className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
                                      isDiscontinued
                                        ? 'border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200'
                                        : 'border-slate-200 text-slate-400 hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50'
                                    }`}
                                    title={isDiscontinued ? 'Click to remove discontinue flag' : 'Mark as will discontinue'}
                                  >
                                    {isDiscontinued ? '⚠ Discontinuing' : 'Discontinue?'}
                                  </button>
                                </div>
                              </div>
                              {info ? (
                                <div className="space-y-0.5">
                                  {info.phone && (
                                    <a href={`tel:${info.phone.replace(/\D/g,'')}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1">
                                      <span>📞</span> {info.phone}
                                    </a>
                                  )}
                                  {info.email && (
                                    <a href={`mailto:${info.email}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 truncate">
                                      <span>✉</span> {info.email}
                                    </a>
                                  )}
                                  {info.website && (
                                    <a href={info.website} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:underline flex items-center gap-1 truncate">
                                      <span>🌐</span> {info.website.replace('https://','').replace('www.','')}
                                    </a>
                                  )}
                                  {info.rep && (
                                    <div className="mt-1.5 pt-1.5 border-t border-slate-200 space-y-0.5">
                                      <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Rep</p>
                                      <p className="text-[11px] text-slate-700 font-medium">{info.rep.name}</p>
                                      {info.rep.phone && (
                                        <a href={`tel:${info.rep.phone.replace(/\D/g,'')}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1">
                                          <span>📞</span> {info.rep.phone}
                                        </a>
                                      )}
                                      {info.rep.email && (
                                        <a href={`mailto:${info.rep.email}`} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 truncate">
                                          <span>✉</span> {info.rep.email}
                                        </a>
                                      )}
                                      {info.rep.account && (
                                        <p className="text-[11px] text-slate-500">Acct # {info.rep.account}</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-[11px] text-slate-400 italic">Contact info not available</p>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>

                  {/* Open orders */}
                  {d.orders.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100">
                        <h3 className="text-sm font-semibold text-slate-900">Open / Pending Orders</h3>
                        <p className="text-xs text-slate-500 mt-0.5">Last synced {relativeTime(d.cachedAt)}</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-100 bg-slate-50">
                              <th className="text-left px-4 py-2 text-slate-500 font-medium">PO #</th>
                              <th className="text-left px-4 py-2 text-slate-500 font-medium">Vendor</th>
                              <th className="text-left px-4 py-2 text-slate-500 font-medium">Status</th>
                              <th className="text-right px-4 py-2 text-slate-500 font-medium">Qty Ordered</th>
                              <th className="text-right px-4 py-2 text-slate-500 font-medium">Qty Open</th>
                              <th className="text-right px-4 py-2 text-slate-500 font-medium">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {d.orders.slice(0, 50).map((o) => (
                              <tr key={o.id} className="hover:bg-slate-50">
                                <td className="px-4 py-2 font-mono text-slate-600">{o.public_id ?? o.id}</td>
                                <td className="px-4 py-2 text-slate-700 max-w-[150px] truncate">{o.vendorName}</td>
                                <td className="px-4 py-2">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${o.status === 'open' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                                    {o.status}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right text-slate-600">{o.total_qty?.toFixed(0) ?? '—'}</td>
                                <td className="px-4 py-2 text-right text-slate-600">{o.total_open_qty?.toFixed(0) ?? '—'}</td>
                                <td className="px-4 py-2 text-right font-mono text-slate-700">{o.total_cost != null ? fmt(o.total_cost) : '—'}</td>
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
                              <td className="px-3 py-2 font-mono text-slate-700">{o.public_id ?? o.id}</td>
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
