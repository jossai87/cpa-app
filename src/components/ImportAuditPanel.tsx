import { useState } from 'react';
import type { ImportAuditEntry } from '../types';

interface Props {
  entries: ImportAuditEntry[];
  onRemove: (id: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  rentLeasePayments: 'Rent / Lease',
  utilities: 'Utilities',
  businessInsurancePremiums: 'Business Insurance',
  professionalFees: 'Professional Fees',
  marketingAdvertising: 'Marketing',
  officeSupplies: 'Office Supplies',
  bankFees: 'Bank Fees',
  softwareSubscriptions: 'Software',
  royaltyFees: 'Royalty Fees',
  adFundContributions: 'Ad Fund',
  loanInterestPaid: 'Loan Interest',
  loanPrincipalPaid: 'Loan Principal',
  totalEmployeeWages: 'Employee Wages',
  employerHealthInsurance: 'Employer Health Ins.',
  total1099Payments: '1099 Payments',
  totalEquipmentCost: 'Equipment',
  ownerHealthInsurancePremiums: 'Owner Health Ins.',
};

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ImportAuditPanel({ entries, onRemove }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Aggregate totals across all entries (what's currently applied to the form)
  const grandTotals: Record<string, number> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.appliedTotals)) {
      if (typeof v === 'number') {
        grandTotals[k] = (grandTotals[k] ?? 0) + v;
      }
    }
  }
  const grandTotalKeys = Object.keys(grandTotals).filter((k) => grandTotals[k]! > 0);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between p-4 border-b border-slate-100">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Statement Imports</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {entries.length} statement{entries.length === 1 ? '' : 's'} applied to the form. Remove to subtract their totals.
          </p>
        </div>
      </header>

      {/* Grand totals summary */}
      {grandTotalKeys.length > 0 && (
        <div className="p-4 bg-slate-50 border-b border-slate-100">
          <p className="text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
            Total imported across all statements
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-sm">
            {grandTotalKeys.map((k) => (
              <div key={k} className="flex justify-between">
                <span className="text-slate-700">{CATEGORY_LABELS[k] ?? k}</span>
                <span className="font-medium text-slate-900">{fmt(grandTotals[k]!)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-statement entries */}
      <ul className="divide-y divide-slate-100">
        {entries.map((entry) => {
          const isExpanded = expandedId === entry.id;
          const totalKeys = Object.keys(entry.appliedTotals).filter(
            (k) => (entry.appliedTotals as Record<string, number>)[k]! > 0
          );
          const grossApplied = totalKeys.reduce(
            (sum, k) => sum + ((entry.appliedTotals as Record<string, number>)[k] ?? 0),
            0
          );
          return (
            <li key={entry.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="flex-1 text-left"
                >
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {entry.fileName}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {entry.bankName ? `${entry.bankName} · ` : ''}
                    {entry.periodStart && entry.periodEnd
                      ? `${fmtDate(entry.periodStart)} – ${fmtDate(entry.periodEnd)}`
                      : `Uploaded ${fmtDate(entry.uploadedAt)}`}
                    {' · '}
                    <span className="font-medium text-slate-700">{fmt(grossApplied)}</span>
                    {' applied'}
                    {entry.flagged.length > 0 && (
                      <span className="ml-2 text-amber-600">
                        · {entry.flagged.length} flagged
                      </span>
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(entry.id)}
                  className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700 transition"
                  aria-label={`Remove ${entry.fileName}`}
                >
                  Remove
                </button>
              </div>

              {isExpanded && (
                <div className="mt-3 space-y-3">
                  {totalKeys.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-600 uppercase tracking-wide mb-1">
                        Categorized
                      </p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm">
                        {totalKeys.map((k) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-slate-700">
                              {CATEGORY_LABELS[k] ?? k}
                            </span>
                            <span className="text-slate-900">
                              {fmt((entry.appliedTotals as Record<string, number>)[k]!)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {entry.flagged.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-1">
                        Flagged for manual review ({entry.flagged.length})
                      </p>
                      <ul className="space-y-1 text-xs">
                        {entry.flagged.map((t, i) => (
                          <li
                            key={i}
                            className="flex items-start justify-between gap-2 bg-amber-50 rounded px-2 py-1.5"
                          >
                            <div className="flex-1 min-w-0">
                              <span className="text-slate-700">
                                {fmtDate(t.date)} · {t.description}
                              </span>
                              <p className="text-amber-700 mt-0.5 italic">{t.reason}</p>
                            </div>
                            <span className="text-slate-900 font-medium whitespace-nowrap">
                              {fmt(t.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
