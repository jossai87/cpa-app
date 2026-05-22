/**
 * VendorHealthCard — single row that fuses POS performance with email
 * activity for one vendor brand. Used inside the Purchasing tab.
 *
 * Backed by GET /pos/vendor-health which joins POS#REPORTING#SALES brand
 * rows with the GMAIL#VENDOR#<brand> cache pointers.
 */

import { useQuery } from '@tanstack/react-query';
import {
  Package,
  Mail,
  TrendingUp,
  Clock,
  AlertCircle,
  Loader2,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import { useState } from 'react';
import api from '../lib/api';
import { gmailMessageUrl, gmailSearchUrl } from '../lib/gmailLinks';

interface VendorBrand {
  brand: string;
  netSalesYTD: number;
  unitsYTD: number;
  emailActivity: {
    messageCount: number;
    lastContactDate: string | null;
    topSenders: Array<{ from: string; count: number }>;
    topSubjects: Array<{ subject: string; count: number }>;
    recentMessageIds: string[];
  } | null;
}

interface VendorHealthResponse {
  asOf: string;
  cacheReady: boolean;
  cacheCoverage: {
    totalMessages: number;
    oldestDate: string | null;
    newestDate: string | null;
  } | null;
  brands: VendorBrand[];
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function daysAgo(iso: string | null): string | null {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d < 1) return 'today';
  if (d === 1) return '1 day ago';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} wks ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

function freshnessClass(iso: string | null): string {
  if (!iso) return 'text-slate-400';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 14) return 'text-emerald-700';
  if (days <= 45) return 'text-amber-700';
  return 'text-slate-500';
}

/** Pull a bare email out of a "Display Name <email@host>" string. */
function extractEmail(fromHeader: string): string | null {
  const m = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/([\w.+-]+@[\w.-]+)/);
  return m?.[1] ?? null;
}

function VendorRow({ vendor }: { vendor: VendorBrand }) {
  const [expanded, setExpanded] = useState(false);
  const a = vendor.emailActivity;
  const last = a?.lastContactDate ?? null;

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-4 px-4 py-3 hover:bg-slate-50 transition text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <p className="text-sm font-medium text-slate-900 truncate">{vendor.brand}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 mt-0.5">
            <span className="flex items-center gap-1">
              <TrendingUp className="w-3 h-3" />
              {formatMoney(vendor.netSalesYTD)} YTD · {vendor.unitsYTD} units
            </span>
            {a ? (
              <>
                <span className="flex items-center gap-1">
                  <Mail className="w-3 h-3" />
                  {a.messageCount} msg{a.messageCount === 1 ? '' : 's'} (90d)
                </span>
                {last && (
                  <span className={`flex items-center gap-1 ${freshnessClass(last)}`}>
                    <Clock className="w-3 h-3" />
                    Last: {daysAgo(last)}
                  </span>
                )}
              </>
            ) : (
              <span className="flex items-center gap-1 text-slate-400">
                <Mail className="w-3 h-3" />
                no inbox activity
              </span>
            )}
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && a && (
        <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50 space-y-2.5">
          {a.recentMessageIds.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-1">
                Recent Threads
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {a.recentMessageIds.slice(0, 5).map((id, i) => (
                  <a
                    key={id}
                    href={gmailMessageUrl(id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded px-1.5 py-0.5 transition"
                    title={`Open thread ${id} in Gmail`}
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                    Thread {i + 1}
                  </a>
                ))}
                <a
                  href={gmailSearchUrl(`from:${vendor.brand} OR subject:${vendor.brand} newer_than:90d`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 hover:text-emerald-700 hover:underline transition ml-1"
                  title={`Search Gmail for all ${vendor.brand} emails in the last 90 days`}
                >
                  All in Gmail
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </div>
          )}
          {a.topSenders.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-1">
                Top Senders
              </p>
              <ul className="space-y-0.5">
                {a.topSenders.map((s, i) => {
                  const email = extractEmail(s.from);
                  const searchQuery = email
                    ? `from:${email} newer_than:90d`
                    : `from:${s.from.split('<')[0]?.trim() || s.from} newer_than:90d`;
                  return (
                    <li key={i} className="text-xs">
                      <a
                        href={gmailSearchUrl(searchQuery)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-700 hover:text-emerald-700 hover:underline inline-flex items-center gap-1"
                        title={`Open Gmail filtered to this sender`}
                      >
                        {s.from} <span className="text-slate-400">({s.count})</span>
                        <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {a.topSubjects.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-1">
                Recent Subjects
              </p>
              <ul className="space-y-0.5">
                {a.topSubjects.map((s, i) => {
                  // Strip common prefixes ([EXT], Re:, Fwd:) for a clean
                  // search query. Quotes preserve the phrase match.
                  const clean = s.subject
                    .replace(/^\[[^\]]+\]\s*/g, '')
                    .replace(/^(re|fwd?):\s*/gi, '')
                    .trim()
                    .slice(0, 80);
                  const searchQuery = clean
                    ? `subject:"${clean}" newer_than:90d`
                    : `subject:"${s.subject.slice(0, 60)}"`;
                  return (
                    <li key={i} className="text-xs truncate">
                      <a
                        href={gmailSearchUrl(searchQuery)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-700 hover:text-emerald-700 hover:underline inline-flex items-center gap-1 max-w-full"
                        title="Open Gmail search for this subject"
                      >
                        <span className="truncate">{s.subject}</span>
                        <ExternalLink className="w-2.5 h-2.5 opacity-60 flex-shrink-0" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      {expanded && !a && (
        <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50 text-xs text-slate-500 italic">
          No emails from this vendor in the last 90 days. Try a "Sync now" on the Gmail Analysis page if you expect activity.
        </div>
      )}
    </div>
  );
}

export default function VendorHealthCard() {
  const q = useQuery<VendorHealthResponse>({
    queryKey: ['pos', 'vendor-health'],
    queryFn: () => api.get<VendorHealthResponse>('/pos/vendor-health').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700">
          <Package className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Vendor Health</h2>
          <p className="text-[11px] text-slate-500">
            Top brands by YTD sales · joined with last 90 days of inbox activity
          </p>
        </div>
        {q.data && !q.data.cacheReady && (
          <span className="text-[10px] px-2 py-1 rounded bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Cache empty
          </span>
        )}
      </div>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading vendor health…
        </div>
      )}

      {q.isError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          Failed to load: {(q.error as Error)?.message ?? 'unknown error'}
        </div>
      )}

      {q.data && q.data.brands.length === 0 && (
        <p className="text-sm text-slate-500 italic px-4 py-3 bg-slate-50 rounded-lg border border-slate-100">
          No brand sales data yet. Run a Heartland sync first.
        </p>
      )}

      {q.data && q.data.brands.length > 0 && (
        <div className="space-y-2">
          {q.data.brands.map((b) => (
            <VendorRow key={b.brand} vendor={b} />
          ))}
        </div>
      )}
    </section>
  );
}
