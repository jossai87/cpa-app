/**
 * OrderRow — single Open/Pending Order with click-to-expand line detail.
 *
 * Used inside the Open/Pending Orders table on the Sales & Revenue → Purchasing
 * tab. Lazy-fetches order lines from /pos/purchasing/orders/{id}/lines on
 * first expand, then caches them.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import api from '../lib/api';

interface Order {
  id: number;
  public_id?: string;
  status?: string;
  vendorName?: string;
  total_qty?: number;
  total_open_qty?: number;
  total_cost?: number;
  created_at?: string;
}

interface OrderLine {
  id: number;
  item_id: number;
  qty: number;
  qty_received: number;
  qty_open: number;
  unit_cost: number;
  extended_cost?: number;
  status?: string;
  name?: string;
  sku?: string;
  brand?: string;
  size?: string;
  color?: string;
  width?: string;
  department?: string;
}

interface LinesResponse {
  orderId: number;
  lineCount: number;
  lines: OrderLine[];
}

function CopyPoButton({ po }: { po: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(po).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-slate-400 hover:text-slate-700 transition"
      aria-label="Copy PO number"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function fmtMoney(n?: number | null): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function daysSince(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export default function OrderRow({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);

  const linesQ = useQuery<LinesResponse>({
    queryKey: ['pos', 'order-lines', order.id],
    queryFn: () =>
      api.get<LinesResponse>(`/pos/purchasing/orders/${order.id}/lines`).then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const days = daysSince(order.created_at);
  const ageClass =
    days == null
      ? ''
      : days >= 60
      ? 'text-red-700'
      : days >= 30
      ? 'text-amber-700'
      : 'text-slate-600';

  return (
    <>
      <tr
        className="hover:bg-slate-50 cursor-pointer"
        onClick={() => setOpen((x) => !x)}
      >
        <td className="px-4 py-2">
          <ChevronDown
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </td>
        <td className="px-4 py-2 font-mono text-slate-600">
          <span className="flex items-center gap-1.5">
            {order.public_id ?? order.id}
            <CopyPoButton po={String(order.public_id ?? order.id)} />
          </span>
        </td>
        <td className="px-4 py-2 text-slate-700 max-w-[150px] truncate">
          {order.vendorName ?? '—'}
        </td>
        <td className="px-4 py-2">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              order.status === 'open' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
            }`}
          >
            {order.status}
          </span>
        </td>
        <td className="px-4 py-2 text-slate-600 whitespace-nowrap">
          {fmtDate(order.created_at)}
        </td>
        <td className={`px-4 py-2 text-right font-medium whitespace-nowrap ${ageClass}`}>
          {days != null ? `${days}d` : '—'}
        </td>
        <td className="px-4 py-2 text-right text-slate-600">
          {order.total_qty?.toFixed(0) ?? '—'}
        </td>
        <td className="px-4 py-2 text-right text-slate-600">
          {order.total_open_qty?.toFixed(0) ?? '—'}
        </td>
        <td className="px-4 py-2 text-right font-mono text-slate-700">
          {fmtMoney(order.total_cost)}
        </td>
      </tr>

      {open && (
        <tr className="bg-slate-50/60">
          <td colSpan={9} className="px-4 py-3">
            {linesQ.isLoading && (
              <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading line items…
              </div>
            )}
            {linesQ.isError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>Failed to load lines: {(linesQ.error as Error)?.message ?? 'unknown'}</span>
              </div>
            )}
            {linesQ.data && linesQ.data.lines.length === 0 && (
              <p className="text-xs text-slate-500 italic">No line items on this order.</p>
            )}
            {linesQ.data && linesQ.data.lines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-left py-1.5 px-2 font-medium">Product</th>
                      <th className="text-left py-1.5 px-2 font-medium">SKU</th>
                      <th className="text-left py-1.5 px-2 font-medium">Brand</th>
                      <th className="text-left py-1.5 px-2 font-medium">Specs</th>
                      <th className="text-right py-1.5 px-2 font-medium">Ordered</th>
                      <th className="text-right py-1.5 px-2 font-medium">Received</th>
                      <th className="text-right py-1.5 px-2 font-medium">Open</th>
                      <th className="text-right py-1.5 px-2 font-medium">Unit $</th>
                      <th className="text-right py-1.5 px-2 font-medium">Ext. $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linesQ.data.lines.map((l) => {
                      const specs = [l.size, l.width, l.color]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <tr key={l.id} className="border-t border-slate-100">
                          <td className="py-1.5 px-2 text-slate-800 max-w-[260px] truncate">
                            {l.name ?? '—'}
                          </td>
                          <td className="py-1.5 px-2 font-mono text-slate-500">
                            {l.sku ?? '—'}
                          </td>
                          <td className="py-1.5 px-2 text-slate-600">{l.brand ?? '—'}</td>
                          <td className="py-1.5 px-2 text-slate-600">{specs || '—'}</td>
                          <td className="py-1.5 px-2 text-right text-slate-700">
                            {l.qty.toFixed(0)}
                          </td>
                          <td className="py-1.5 px-2 text-right text-slate-700">
                            {l.qty_received.toFixed(0)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-medium text-amber-700">
                            {l.qty_open.toFixed(0)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-600">
                            {fmtMoney(l.unit_cost)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-700">
                            {fmtMoney(l.extended_cost)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[10px] text-slate-400 mt-2 text-right">
                  {linesQ.data.lineCount} line item{linesQ.data.lineCount === 1 ? '' : 's'} ·
                  fetched live from Heartland
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
