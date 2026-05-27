/**
 * CustomerHistoryPanel — slide-over showing a customer's recent purchase
 * timeline. Lazy-loaded on demand from /pos/customers/{id}/history.
 *
 * Layout:
 *   • Header: name + email + total spend + ticket count
 *   • Timeline: ticket cards, newest first, each with date, total, items
 *   • Empty / loading / error states
 */

import { useQuery } from '@tanstack/react-query';
import {
  X,
  Loader2,
  ShoppingBag,
  Calendar,
  User as UserIcon,
  AlertCircle,
  Receipt,
} from 'lucide-react';
import api from '../lib/api';

interface HistoryItem {
  itemId: number | null;
  sku: string | null;
  description: string;
  brand: string | null;
  department: string | null;
  qty: number;
  unitPrice: number;
  originalPrice: number;
  total: number;
  isReturn: boolean;
}

interface HistoryTicket {
  id: number;
  completedAt: string | null;
  total: number;
  totalDiscounts: number;
  salesRep: string | null;
  items: HistoryItem[];
}

interface HistoryResponse {
  customer: {
    id: number;
    name: string;
    email: string | null;
    phoneNumber: string | null;
    lastPurchaseAt: string | null;
    totalSpend: number;
    ticketCount: number;
  };
  tickets: HistoryTicket[];
  truncated: boolean;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function CustomerHistoryPanel({
  customerId,
  customerName,
  onClose,
}: {
  customerId: number;
  customerName: string;
  onClose: () => void;
}) {
  const historyQ = useQuery<HistoryResponse>({
    queryKey: ['customer', 'history', customerId],
    queryFn: () =>
      api
        .get<HistoryResponse>(`/pos/customers/${customerId}/history`)
        .then((r) => r.data),
    staleTime: 5 * 60 * 1000, // cache 5 min
  });

  const data = historyQ.data;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white w-full sm:max-w-xl h-full overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex-shrink-0 px-5 py-4 border-b border-slate-200 bg-gradient-to-r from-indigo-50 to-white">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700">
                  <UserIcon className="w-4 h-4" />
                </div>
                <h2 className="text-base font-semibold text-slate-900 truncate">
                  {data?.customer.name || customerName}
                </h2>
              </div>
              {data?.customer.email && (
                <p className="text-xs text-slate-500 ml-10 truncate">
                  {data.customer.email}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Spend summary */}
          {data && (
            <div className="grid grid-cols-3 gap-2 mt-4">
              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">
                  Spent (last 36mo)
                </p>
                <p className="text-base font-bold text-slate-900 tabular-nums mt-0.5">
                  {formatCurrency(data.customer.totalSpend)}
                </p>
              </div>
              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">
                  Visits
                </p>
                <p className="text-base font-bold text-slate-900 tabular-nums mt-0.5">
                  {data.customer.ticketCount}
                  {data.truncated && (
                    <span className="text-[10px] text-slate-400 font-normal ml-1">
                      +
                    </span>
                  )}
                </p>
              </div>
              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">
                  Last visit
                </p>
                <p className="text-base font-bold text-slate-900 tabular-nums mt-0.5">
                  {data.customer.lastPurchaseAt
                    ? new Date(data.customer.lastPurchaseAt).toLocaleDateString(
                        undefined,
                        { month: 'short', day: 'numeric', year: '2-digit' }
                      )
                    : '—'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Body — scrolling timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {historyQ.isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <p className="text-sm">Loading purchase history…</p>
              <p className="text-[11px] mt-1">
                Pulling fresh data from Heartland — usually 3-8s.
              </p>
            </div>
          ) : historyQ.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm text-red-800">
                <p className="font-medium">Couldn't load history.</p>
                <p className="text-xs mt-1 text-red-700">
                  {(historyQ.error as Error).message}
                </p>
                <button
                  type="button"
                  onClick={() => historyQ.refetch()}
                  className="mt-2 text-xs px-3 py-1 rounded border border-red-300 bg-white text-red-700 hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : !data || data.tickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <ShoppingBag className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm font-medium">No purchases recorded</p>
              <p className="text-[11px] mt-1 text-center max-w-xs">
                This customer is in your Heartland database but doesn't have
                any completed tickets in the last 36 months.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {data.tickets.map((t) => (
                <li
                  key={t.id}
                  className="rounded-lg border border-slate-200 bg-white overflow-hidden"
                >
                  {/* Ticket header */}
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
                    <div className="flex items-center gap-2 min-w-0">
                      <Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className="text-xs font-medium text-slate-800">
                        {formatDate(t.completedAt)}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {formatTime(t.completedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {t.salesRep && (
                        <span className="text-slate-500 truncate max-w-[100px]">
                          by {t.salesRep}
                        </span>
                      )}
                      <span className="font-bold text-slate-900 tabular-nums">
                        {formatCurrency(t.total)}
                      </span>
                    </div>
                  </div>

                  {/* Items */}
                  {t.items.length === 0 ? (
                    <p className="px-3 py-2 text-[11px] text-slate-400 italic">
                      Items not available for this ticket.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {t.items.map((item, idx) => (
                        <li
                          key={`${t.id}-${idx}`}
                          className={`px-3 py-2 ${
                            item.isReturn ? 'bg-rose-50/40' : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-slate-800 truncate">
                                {item.isReturn && (
                                  <span className="text-[9px] uppercase tracking-wide text-rose-700 bg-rose-100 px-1 py-0.5 rounded mr-1.5">
                                    return
                                  </span>
                                )}
                                {item.description}
                              </p>
                              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-500">
                                {item.brand && (
                                  <span className="font-medium text-slate-600">
                                    {item.brand}
                                  </span>
                                )}
                                {item.department && (
                                  <span className="text-slate-400">
                                    · {item.department}
                                  </span>
                                )}
                                {item.sku && (
                                  <span className="text-slate-400 ml-auto sm:ml-0">
                                    SKU {item.sku}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex-shrink-0 text-right">
                              <p
                                className={`text-xs font-semibold tabular-nums ${
                                  item.isReturn
                                    ? 'text-rose-700'
                                    : 'text-slate-900'
                                }`}
                              >
                                {formatCurrency(item.total)}
                              </p>
                              <p className="text-[10px] text-slate-400 tabular-nums">
                                {item.qty} × {formatCurrency(item.unitPrice)}
                                {item.originalPrice > item.unitPrice && (
                                  <span className="text-emerald-600 ml-1">
                                    (save{' '}
                                    {formatCurrency(
                                      item.originalPrice - item.unitPrice
                                    )}
                                    )
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Footer with discount info if applicable */}
                  {t.totalDiscounts > 0 && (
                    <div className="px-3 py-1.5 bg-emerald-50/40 border-t border-emerald-100 flex items-center gap-1.5 text-[11px] text-emerald-800">
                      <Receipt className="w-3 h-3" />
                      Total discounts:{' '}
                      <span className="font-semibold tabular-nums">
                        {formatCurrency(t.totalDiscounts)}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          {data?.truncated && (
            <p className="text-[11px] text-slate-400 text-center mt-3 italic">
              Showing the 50 most recent tickets. Older history available in
              Heartland.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
