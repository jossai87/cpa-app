import { useState } from 'react';
import { ChevronDown, ChevronRight, Download, Trash2, FileText, Check, X, Undo2 } from 'lucide-react';
import {
  useDocuments,
  useDownloadDocument,
  useDeleteDocument,
  useResolveFlagged,
} from '../hooks/useDocuments';
import type { DocType, PersistedDocument } from '../types';
import Spinner from './Spinner';

interface Props {
  /** Called after a delete with the totals that were applied to the form
   *  by that document, so the parent can subtract them. */
  onDocumentDeleted?: (appliedTotals: Record<string, number>) => void;
  /** Called when a flagged item is resolved (apply / ignore / unresolve).
   *  formDelta is { fieldName: change } where change can be positive or negative. */
  onFlaggedResolved?: (formDelta: Record<string, number>) => void;
  /** Optional refresh trigger — increment to refetch (e.g., after new upload). */
  refreshKey?: number;
}

const DOC_TYPE_LABELS: Record<DocType, string> = {
  auto: 'Auto-detect',
  'profit-loss': 'P&L Statements',
  'bank-statement': 'Bank Statements',
  'line-of-credit': 'Line of Credit',
  'payroll-summary': 'Payroll',
  'royalty-statement': 'Royalty Reports',
  'sales-tax-return': 'Sales Tax Returns',
  'fixed-assets': 'Fixed Assets',
  insurance: 'Insurance',
  lease: 'Lease Agreements',
  general: 'Other',
};

const DOC_TYPE_ORDER: DocType[] = [
  'bank-statement',
  'line-of-credit',
  'profit-loss',
  'royalty-statement',
  'sales-tax-return',
  'payroll-summary',
  'insurance',
  'lease',
  'fixed-assets',
  'general',
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtPeriod(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null;
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
  return `${s.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })} – ${e.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}`;
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function totalApplied(doc: PersistedDocument): number {
  return Object.values(doc.appliedTotals).reduce(
    (sum, v) => sum + (typeof v === 'number' ? v : 0),
    0
  );
}

// Tax-form fields a flagged item can be applied to. Order/labels mirror the
// form sections so the dropdown reads naturally.
const FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'cogs', label: 'Cost of Goods Sold (COGS)' },
  { value: 'rentLeasePayments', label: 'Rent / Lease Payments' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'businessInsurancePremiums', label: 'Business Insurance Premiums' },
  { value: 'marketingAdvertising', label: 'Marketing & Advertising' },
  { value: 'professionalFees', label: 'Professional Fees' },
  { value: 'officeSupplies', label: 'Office Supplies' },
  { value: 'softwareSubscriptions', label: 'Software Subscriptions' },
  { value: 'bankFees', label: 'Bank & Merchant Fees' },
  { value: 'royaltyFees', label: 'Royalty Fees' },
  { value: 'adFundContributions', label: 'Ad Fund Contributions' },
  { value: 'loanInterestPaid', label: 'Loan Interest Paid' },
  { value: 'loanPrincipalPaid', label: 'Loan Principal Paid (informational)' },
  { value: 'totalEmployeeWages', label: 'Total Employee Wages' },
  { value: 'employerHealthInsurance', label: 'Employer-Paid Employee Health Insurance' },
  { value: 'total1099Payments', label: '1099 Contractor Payments' },
  { value: 'totalEquipmentCost', label: 'Equipment Cost' },
  { value: 'ownerHealthInsurancePremiums', label: 'Owner Health Insurance' },
  { value: 'totalRevenue', label: 'Total Revenue (deposit)' },
  { value: 'salesTaxCollected', label: 'Sales Tax Collected' },
  { value: 'salesTaxRemitted', label: 'Sales Tax Remitted' },
];

function fieldLabel(field?: string): string {
  return FIELD_OPTIONS.find((o) => o.value === field)?.label ?? field ?? '';
}

function FlaggedRow({
  docId,
  index,
  flagged,
  onResolved,
}: {
  docId: string;
  index: number;
  flagged: PersistedDocument['flagged'][number];
  onResolved: (formDelta: Record<string, number>) => void;
}) {
  const resolveMut = useResolveFlagged();
  const [picking, setPicking] = useState(false);
  const txnAmount = Math.abs(flagged.amount);
  // Seed the dropdown with the AI's bestGuessField if it matches one of our
  // supported categories. This pre-selects but does NOT auto-apply — the user
  // still has to click "Apply" to commit. If the guess is unknown or missing,
  // start with an empty selection so the user has to actively choose.
  const initialFieldGuess =
    flagged.bestGuessField &&
    FIELD_OPTIONS.some((o) => o.value === flagged.bestGuessField)
      ? flagged.bestGuessField
      : '';
  const [field, setField] = useState<string>(initialFieldGuess);
  const [amountStr, setAmountStr] = useState<string>(String(txnAmount));
  const isResolved = !!flagged.resolution;

  // Color of the suggestion hint reflects how confident the AI is
  const guessHintColor =
    flagged.guessConfidence === 'high'
      ? 'text-emerald-700'
      : flagged.guessConfidence === 'medium'
        ? 'text-amber-700'
        : 'text-slate-500';

  async function applyResolution() {
    if (!field) return;
    const amt = Number(amountStr);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const r = await resolveMut.mutateAsync({
      docId,
      index,
      action: 'apply',
      field,
      appliedAmount: amt,
    });
    setPicking(false);
    onResolved(r.formDelta);
  }
  async function ignore() {
    const r = await resolveMut.mutateAsync({ docId, index, action: 'ignore' });
    onResolved(r.formDelta);
  }
  async function undo() {
    const r = await resolveMut.mutateAsync({ docId, index, action: 'unresolve' });
    onResolved(r.formDelta);
  }

  return (
    <li
      className={`text-[10px] leading-snug ${
        isResolved ? 'text-slate-400' : 'text-slate-700'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`font-medium truncate ${
            isResolved ? 'line-through text-slate-400' : 'text-slate-900'
          }`}
        >
          {flagged.description}
        </span>
        <span
          className={`font-mono whitespace-nowrap ${
            isResolved ? 'text-slate-400' : 'text-slate-900'
          }`}
        >
          {fmtMoney(flagged.amount)}
        </span>
      </div>
      <div className="text-slate-500">
        {flagged.date}
        {flagged.reason && <> · {flagged.reason}</>}
      </div>

      {/* Resolution status + action buttons */}
      {isResolved ? (
        <div className="mt-0.5 flex items-center gap-2">
          {flagged.resolution!.action === 'apply' ? (
            <span className="text-emerald-700">
              ✓ Applied {fmtMoney(flagged.resolution!.appliedAmount ?? 0)} to{' '}
              {fieldLabel(flagged.resolution!.field)}
            </span>
          ) : (
            <span className="text-slate-500">✓ Ignored</span>
          )}
          <button
            type="button"
            onClick={() => void undo()}
            disabled={resolveMut.isPending}
            className="text-blue-600 hover:underline disabled:opacity-50 inline-flex items-center gap-0.5"
          >
            <Undo2 className="w-2.5 h-2.5" /> undo
          </button>
        </div>
      ) : picking ? (
        <div className="mt-1 space-y-1 bg-white rounded border border-amber-200 p-1.5">
          <select
            value={field}
            onChange={(e) => setField(e.target.value)}
            className="w-full text-[10px] py-0.5 px-1 rounded border border-slate-200 focus:border-blue-500 focus:ring-0"
          >
            <option value="">— pick a category —</option>
            {FIELD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {initialFieldGuess && field === initialFieldGuess && (
            <p className={`text-[9px] ${guessHintColor} leading-tight`}>
              AI suggested this category
              {flagged.guessConfidence
                ? ` (${flagged.guessConfidence} confidence)`
                : ''}
              . Change it if you disagree.
            </p>
          )}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500">$</span>
            <input
              type="number"
              min={0}
              step="any"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="flex-1 text-[10px] py-0.5 px-1 rounded border border-slate-200 focus:border-blue-500 focus:ring-0 font-mono"
            />
            <button
              type="button"
              onClick={() => void applyResolution()}
              disabled={!field || resolveMut.isPending}
              className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed inline-flex items-center gap-0.5"
            >
              <Check className="w-2.5 h-2.5" /> Apply
            </button>
            <button
              type="button"
              onClick={() => setPicking(false)}
              disabled={resolveMut.isPending}
              className="px-1 py-0.5 text-[10px] rounded text-slate-500 hover:bg-slate-100"
              aria-label="Cancel"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
          <p className="text-[9px] text-slate-500 leading-tight">
            Defaulted to {fmtMoney(txnAmount)}. Adjust if only part of this
            transaction is a business expense.
          </p>
        </div>
      ) : (
        <div className="mt-0.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={resolveMut.isPending}
            className="text-blue-600 hover:underline disabled:opacity-50"
          >
            Categorize
            {initialFieldGuess && (
              <span className={`ml-1 ${guessHintColor}`}>
                (AI suggests:{' '}
                {FIELD_OPTIONS.find((o) => o.value === initialFieldGuess)?.label})
              </span>
            )}
          </button>
          <span className="text-slate-300">|</span>
          <button
            type="button"
            onClick={() => void ignore()}
            disabled={resolveMut.isPending}
            className="text-slate-500 hover:underline disabled:opacity-50"
          >
            Ignore
          </button>
        </div>
      )}
    </li>
  );
}

function DocumentRow({
  doc,
  onDelete,
  onDownload,
  onFlaggedResolved,
  isDeleting,
  isDownloading,
}: {
  doc: PersistedDocument;
  onDelete: () => void;
  onDownload: () => void;
  onFlaggedResolved: (formDelta: Record<string, number>) => void;
  isDeleting: boolean;
  isDownloading: boolean;
}) {
  const period = fmtPeriod(doc.periodStart, doc.periodEnd);
  const total = totalApplied(doc);
  const guessLabel =
    doc.docType === 'general' && doc.autoClassifyResult?.bestGuessLabel
      ? doc.autoClassifyResult.bestGuessLabel
      : null;
  const [showFlagged, setShowFlagged] = useState(false);
  const flaggedCount = doc.flagged?.length ?? 0;
  const unresolvedCount = (doc.flagged ?? []).filter((f) => !f.resolution).length;

  return (
    <li className="px-3 py-2 hover:bg-slate-50 group">
      <div className="flex items-start gap-2">
        <FileText className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-900 truncate" title={doc.fileName}>
            {doc.fileName}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {guessLabel && <span className="italic">~{guessLabel} · </span>}
            {doc.bankName ? `${doc.bankName} · ` : ''}
            {period ?? `Uploaded ${fmtDate(doc.uploadedAt)}`}
            {total > 0 && ` · ${fmtMoney(total)}`}
            {flaggedCount > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowFlagged((v) => !v)}
                  title="Transactions the AI couldn't confidently categorize. Click to review them."
                  className={`hover:underline focus:outline-none focus-visible:underline ${
                    unresolvedCount > 0
                      ? 'text-amber-600 hover:text-amber-800'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {unresolvedCount > 0
                    ? `${unresolvedCount} of ${flaggedCount} flagged`
                    : `${flaggedCount} flagged (resolved)`}
                  {' '}
                  {showFlagged ? '▾' : '▸'}
                </button>
              </>
            )}
          </p>
          {showFlagged && flaggedCount > 0 && (
            <div className="mt-1.5 rounded border border-amber-200 bg-amber-50 p-2">
              <p className="text-[10px] text-amber-900 mb-1.5 leading-snug">
                These transactions weren't auto-applied because the AI couldn't
                confidently match them to a tax category. Categorize each as a
                business expense field, or Ignore if it's personal/non-deductible.
              </p>
              <ul className="space-y-2">
                {doc.flagged.map((f, i) => (
                  <FlaggedRow
                    key={`${doc.docId}-flagged-${i}`}
                    docId={doc.docId}
                    index={i}
                    flagged={f}
                    onResolved={onFlaggedResolved}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
          <button
            type="button"
            onClick={onDownload}
            disabled={isDownloading}
            aria-label="Download"
            title="Download"
            className="p-1 rounded hover:bg-slate-200 text-slate-500"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label="Delete"
            title="Delete"
            className="p-1 rounded hover:bg-red-100 hover:text-red-700 text-slate-500"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}

export default function DocumentsSidebar({
  onDocumentDeleted,
  onFlaggedResolved,
}: Props) {
  const { data: documents, isLoading, isError } = useDocuments();
  const downloadMut = useDownloadDocument();
  const deleteMut = useDeleteDocument();

  const [expandedGroups, setExpandedGroups] = useState<Set<DocType>>(
    new Set(['bank-statement', 'line-of-credit', 'insurance'])
  );

  function toggleGroup(t: DocType) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function handleDelete(doc: PersistedDocument) {
    const ok = window.confirm(
      `Delete "${doc.fileName}"? This will subtract its categorized totals from the form and remove the file from secure storage.`
    );
    if (!ok) return;
    const result = await deleteMut.mutateAsync(doc.docId);
    onDocumentDeleted?.(result.appliedTotals as Record<string, number>);
  }

  // Group docs by type
  const groups: Record<string, PersistedDocument[]> = {};
  for (const d of documents ?? []) {
    const key = d.docType;
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(d);
  }

  const total = documents?.length ?? 0;

  return (
    <aside className="w-72 flex-shrink-0 bg-white rounded-lg border border-slate-200 overflow-hidden self-start sticky top-4">
      <header className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-900">Uploaded Documents</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          {isLoading
            ? 'Loading…'
            : total === 0
              ? 'No files yet — upload one above'
              : `${total} file${total === 1 ? '' : 's'} stored`}
        </p>
      </header>

      {isLoading && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      )}

      {isError && (
        <div className="p-3 text-xs text-red-600">Failed to load documents.</div>
      )}

      {!isLoading && total > 0 && (
        <div className="max-h-[70vh] overflow-y-auto">
          {DOC_TYPE_ORDER.filter((t) => groups[t]?.length).map((t) => {
            const docsInGroup = groups[t]!;
            const isExpanded = expandedGroups.has(t);
            return (
              <div key={t} className="border-b border-slate-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleGroup(t)}
                  className="w-full px-3 py-2 flex items-center gap-1.5 text-left hover:bg-slate-50"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                  <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                    {DOC_TYPE_LABELS[t]}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">
                    {docsInGroup.length}
                  </span>
                </button>
                {isExpanded && (
                  <ul className="divide-y divide-slate-50">
                    {docsInGroup.map((d) => (
                      <DocumentRow
                        key={d.docId}
                        doc={d}
                        onDelete={() => handleDelete(d)}
                        onDownload={() => downloadMut.mutate(d.docId)}
                        onFlaggedResolved={(delta) =>
                          onFlaggedResolved?.(delta)
                        }
                        isDeleting={deleteMut.isPending}
                        isDownloading={downloadMut.isPending}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
