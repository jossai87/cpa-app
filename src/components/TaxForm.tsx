import { useState, useEffect, useImperativeHandle, forwardRef, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import type { TaxFormData, EntityType, FilingStatus, ImportAuditEntry } from '../types';
import DocumentUpload from './DocumentUpload';
import HelpHint from './HelpHint';
import ImportAuditPanel from './ImportAuditPanel';
import api from '../lib/api';

// Per the Foot Solutions FDD, royalty is 5% and the national ad fund is 2% of gross sales.
// Mirror values in lambda/shared/taxConstants.ts (FOOT_SOLUTIONS).
const ROYALTY_RATE = 0.05;
const AD_FUND_RATE = 0.02;

// Per-field source attribution: which uploaded docs contributed to a field's value.
export type FieldProvenance = Record<
  string,
  Array<{ fileName: string; amount: number; confidence: 'high' | 'medium' | 'low' }>
>;

interface Props {
  onSubmit: (data: TaxFormData) => void;
  initialData?: Partial<TaxFormData>;
  loading?: boolean;
  /** Map of field-name → contributing documents, derived from persisted uploads. */
  fieldProvenance?: FieldProvenance;
}

export interface TaxFormHandle {
  /** Subtract a set of numeric totals from the form (used when a doc is deleted). */
  subtractTotals: (totals: Record<string, number>) => void;
  /** Apply a signed delta map to the form (positive adds, negative subtracts). */
  applyDelta: (delta: Record<string, number>) => void;
  /** Reset the form to defaults and clear the saved localStorage draft. */
  clearDraft: () => void;
  /** Replace the current form state with the given data (used to reload a past session). */
  loadInputData: (data: Partial<TaxFormData>) => void;
  /**
   * Seed the form with summed totals from previously-uploaded documents, but only
   * if the corresponding field is currently empty (0 / undefined). Existing values
   * are left alone. Returns the count of fields actually filled.
   */
  hydrateFromDocuments: (totals: Record<string, number>) => number;
  /** Get a snapshot of the current form data (used to build CPA package). */
  getFormData: () => TaxFormData;
}

const DRAFT_STORAGE_KEY = 'foot-solutions:tax-form-draft';

const DEFAULT_FORM: TaxFormData = {
  taxYear: 2026,
  entityType: 'LLC',
  filingStatus: 'marriedFilingJointly',
  isSoleOwner: true,
  isFranchise: true,
  isRetail: true,
  isMultiState: false,

  totalRevenue: 0,
  cogs: 0,
  beginningInventory: undefined,
  endingInventory: undefined,

  totalOperatingExpenses: 0,
  rentLeasePayments: 0,
  utilities: undefined,
  businessInsurancePremiums: 0,
  professionalFees: undefined,
  marketingAdvertising: undefined,
  officeSupplies: undefined,
  bankFees: undefined,
  softwareSubscriptions: undefined,

  hasEmployees: false,
  hasContractors: false,
  hasBusinessVehicle: false,
  hasHomeOffice: false,
  hasEquipment: false,
  hasBusinessLoans: false,

  royaltyFees: undefined,
  adFundContributions: undefined,
  initialFranchiseFeePaidThisYear: undefined,

  ownershipPercent: 100,
  ownerHealthInsurancePremiums: 0,

  useStandards: true,
};

// ── Reusable input components ────────────────────────────────────────

function NumberInput({
  label,
  value,
  onChange,
  prefix,
  hint,
  help,
  required,
  min = 0,
  step,
  sources,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  prefix?: string;
  hint?: string;
  help?: string;
  required?: boolean;
  min?: number;
  step?: number;
  sources?: Array<{
    fileName: string;
    amount: number;
    confidence: 'high' | 'medium' | 'low';
  }>;
}) {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(n);

  // Map confidence levels to a numeric score, percentage, label, and color class.
  const confMeta: Record<
    'high' | 'medium' | 'low',
    { score: number; pct: string; dotClass: string; pillClass: string; label: string }
  > = {
    high: {
      score: 3,
      pct: '90%',
      dotClass: 'bg-emerald-500',
      pillClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      label: 'High',
    },
    medium: {
      score: 2,
      pct: '60%',
      dotClass: 'bg-amber-500',
      pillClass: 'bg-amber-50 text-amber-700 border-amber-200',
      label: 'Medium',
    },
    low: {
      score: 1,
      pct: '30%',
      dotClass: 'bg-rose-500',
      pillClass: 'bg-rose-50 text-rose-700 border-rose-200',
      label: 'Low',
    },
  };

  // Aggregate confidence across all contributing sources = the WORST one.
  // If any doc was low-confidence, the field is shown as low.
  const aggregateConfidence: 'high' | 'medium' | 'low' | null =
    sources && sources.length > 0
      ? sources.reduce<'high' | 'medium' | 'low'>(
          (worst, s) =>
            confMeta[s.confidence].score < confMeta[worst].score ? s.confidence : worst,
          'high'
        )
      : null;

  // Only show the source caption if the input has a real value
  const showSources =
    sources && sources.length > 0 && value !== undefined && value !== 0;

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center flex-wrap">
        <span>{label}</span>
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {help && <HelpHint text={help} label={label} />}
        {showSources && aggregateConfidence && (
          <span
            className={`ml-auto inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${confMeta[aggregateConfidence].pillClass}`}
            title={`AI confidence: ${confMeta[aggregateConfidence].label} (~${confMeta[aggregateConfidence].pct}). Verify low/medium-confidence values manually.`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${confMeta[aggregateConfidence].dotClass}`}
              aria-hidden="true"
            />
            {confMeta[aggregateConfidence].pct}
          </span>
        )}
      </label>
      {hint && <p className="text-xs text-slate-500 mb-1">{hint}</p>}
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
            {prefix}
          </span>
        )}
        <input
          type="number"
          min={min}
          step={step ?? 'any'}
          value={value ?? ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? undefined : Number(e.target.value))
          }
          className={`w-full rounded-md border border-slate-300 py-2 ${
            prefix ? 'pl-7 pr-3' : 'px-3'
          } text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500`}
        />
      </div>
      {showSources && (
        <div className="mt-1 space-y-0.5">
          {sources!.slice(0, 3).map((s, i) => {
            const cm = confMeta[s.confidence];
            return (
              <p
                key={`${s.fileName}-${i}`}
                className="text-[11px] text-slate-600 leading-tight flex items-center gap-1.5"
                title={`${s.fileName}: ${fmt(s.amount)} (${cm.label} confidence)`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${cm.dotClass} flex-shrink-0`}
                  aria-hidden="true"
                />
                <FileText
                  className="w-3 h-3 text-slate-400 flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">
                  <span className="text-slate-700">{s.fileName}</span>
                  <span className="text-slate-500"> · {fmt(s.amount)}</span>
                </span>
              </p>
            );
          })}
          {sources!.length > 3 && (
            <p className="text-[11px] text-slate-500 italic pl-4">
              +{sources!.length - 3} more
            </p>
          )}
          {aggregateConfidence === 'low' && (
            <p className="text-[11px] text-rose-700 leading-tight">
              ⚠ Low confidence — please verify this value manually before submitting.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  required,
  help,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  required?: boolean;
  help?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        <span>{label}</span>
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {help && <HelpHint text={help} label={label} />}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-md border border-slate-300 py-2 px-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  hint,
  help,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  help?: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer p-3 rounded-md border border-slate-200 hover:bg-slate-50 transition">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-700 flex items-center">
          <span>{label}</span>
          {help && <HelpHint text={help} label={label} />}
        </div>
        {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-slate-200 pt-6 mt-6">
      <h3 className="text-base font-semibold text-slate-900 mb-1">{title}</h3>
      {description && <p className="text-sm text-slate-500 mb-4">{description}</p>}
      {children}
    </div>
  );
}

// ── Main form ────────────────────────────────────────────────────────

export default forwardRef<TaxFormHandle, Props>(function TaxForm(
  { onSubmit, initialData, loading, fieldProvenance },
  ref
) {
  const queryClient = useQueryClient();

  // Helper: look up the documents that contributed to a given field. Returns
  // undefined when there's no provenance, so NumberInput skips rendering the caption.
  const sourcesFor = (field: keyof TaxFormData) =>
    fieldProvenance?.[field as string];

  // Restore draft from localStorage if present, otherwise use defaults + initialData
  const [form, setForm] = useState<TaxFormData>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(DRAFT_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Partial<TaxFormData>;
          return { ...DEFAULT_FORM, ...initialData, ...parsed };
        }
      } catch {
        // Corrupt JSON or storage unavailable — fall through to defaults
      }
    }
    return { ...DEFAULT_FORM, ...initialData };
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<ImportAuditEntry[]>([]);

  // Tracks which franchise-fee fields the user has typed in directly.
  // If a field is in this set, the auto-calc effect leaves it alone.
  // Document extraction also marks fields here so it doesn't get overwritten.
  const manuallyEditedRef = useRef<Set<string>>(new Set());

  // Persist form to localStorage on every change so refreshes keep your work
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(form));
    } catch {
      // Storage full or denied — silent fail
    }
  }, [form]);

  // Auto-calculate franchise royalty (5%) and ad fund (2%) from total revenue,
  // but only if the user hasn't manually overridden them.
  useEffect(() => {
    if (!form.isFranchise) return;
    if (!form.totalRevenue || form.totalRevenue <= 0) return;

    const expectedRoyalty = Math.round(form.totalRevenue * ROYALTY_RATE);
    const expectedAdFund = Math.round(form.totalRevenue * AD_FUND_RATE);

    setForm((prev) => {
      const next = { ...prev };
      let changed = false;
      if (
        !manuallyEditedRef.current.has('royaltyFees') &&
        (prev.royaltyFees === undefined || prev.royaltyFees === 0) &&
        expectedRoyalty !== prev.royaltyFees
      ) {
        next.royaltyFees = expectedRoyalty;
        changed = true;
      }
      if (
        !manuallyEditedRef.current.has('adFundContributions') &&
        (prev.adFundContributions === undefined || prev.adFundContributions === 0) &&
        expectedAdFund !== prev.adFundContributions
      ) {
        next.adFundContributions = expectedAdFund;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [form.totalRevenue, form.isFranchise]);

  useEffect(() => {
    if (initialData) {
      setForm((f) => ({ ...f, ...initialData }));
    }
  }, [initialData]);

  // Expose imperative subtractTotals to parent so it can undo a deleted doc
  useImperativeHandle(ref, () => ({
    getFormData() {
      return form;
    },
    subtractTotals(totals) {
      setForm((prev) => {
        const prevAsRecord = prev as unknown as Record<string, unknown>;
        const next: Record<string, unknown> = { ...prevAsRecord };
        for (const [k, v] of Object.entries(totals)) {
          if (typeof v === 'number' && v > 0) {
            const existing = prevAsRecord[k];
            if (typeof existing === 'number') {
              next[k] = Math.max(0, existing - v);
            }
          }
        }
        return next as unknown as TaxFormData;
      });
    },
    applyDelta(delta) {
      setForm((prev) => {
        const prevAsRecord = prev as unknown as Record<string, unknown>;
        const next: Record<string, unknown> = { ...prevAsRecord };
        for (const [k, v] of Object.entries(delta)) {
          if (typeof v !== 'number' || v === 0) continue;
          const existing = prevAsRecord[k];
          const base = typeof existing === 'number' ? existing : 0;
          next[k] = Math.max(0, base + v);
        }
        return next as unknown as TaxFormData;
      });
    },
    clearDraft() {
      setForm({ ...DEFAULT_FORM });
      setAuditEntries([]);
      setImportMsg(null);
      setErrors({});
      manuallyEditedRef.current.clear();
      try {
        window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      } catch {
        // ignore
      }
    },
    loadInputData(data) {
      // Merge over defaults so any missing fields from the saved session
      // (e.g., new fields added later) get sane defaults rather than undefined.
      const merged = { ...DEFAULT_FORM, ...data };
      setForm(merged);
      setAuditEntries([]);
      setImportMsg(null);
      setErrors({});
      // Treat any non-zero franchise values from the loaded session as
      // user-provided so auto-calc doesn't clobber them.
      manuallyEditedRef.current = new Set();
      if (typeof merged.royaltyFees === 'number' && merged.royaltyFees > 0) {
        manuallyEditedRef.current.add('royaltyFees');
      }
      if (
        typeof merged.adFundContributions === 'number' &&
        merged.adFundContributions > 0
      ) {
        manuallyEditedRef.current.add('adFundContributions');
      }
      try {
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // ignore
      }
      // Scroll the form into view so the user sees the loaded values
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    hydrateFromDocuments(totals) {
      let filledCount = 0;
      setForm((prev) => {
        const prevAsRecord = prev as unknown as Record<string, unknown>;
        const next: Record<string, unknown> = { ...prevAsRecord };
        for (const [k, v] of Object.entries(totals)) {
          if (typeof v !== 'number' || v <= 0) continue;
          const existing = prevAsRecord[k];
          // Only fill if currently empty (undefined or 0)
          if (existing === undefined || existing === 0) {
            next[k] = v;
            filledCount++;
            // Mark franchise fields as user-provided so the 5%/2% auto-calc effect
            // doesn't overwrite extracted values from royalty statements.
            if (k === 'royaltyFees' || k === 'adFundContributions') {
              manuallyEditedRef.current.add(k);
            }
          }
        }
        return filledCount > 0 ? (next as unknown as TaxFormData) : prev;
      });
      return filledCount;
    },
  }), [form]);

  function update<K extends keyof TaxFormData>(key: K, value: TaxFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  }

  /**
   * Apply an extracted patch to the form.
   * 'replace' overwrites; 'add' accumulates numeric fields (sums) and replaces booleans.
   */
  function handleExtracted(
    patch: Partial<TaxFormData>,
    mode: 'replace' | 'add'
  ) {
    // If a doc supplies real values for the franchise fields, treat them as
    // user-provided so the 5%/2% auto-calc doesn't overwrite them later.
    if (typeof patch.royaltyFees === 'number' && patch.royaltyFees > 0) {
      manuallyEditedRef.current.add('royaltyFees');
    }
    if (
      typeof patch.adFundContributions === 'number' &&
      patch.adFundContributions > 0
    ) {
      manuallyEditedRef.current.add('adFundContributions');
    }

    setForm((prev) => {
      if (mode === 'replace') {
        return { ...prev, ...patch };
      }
      // add mode: sum numeric fields, replace booleans/strings
      const prevAsRecord = prev as unknown as Record<string, unknown>;
      const next: Record<string, unknown> = { ...prevAsRecord };
      for (const [k, v] of Object.entries(patch)) {
        if (typeof v === 'number') {
          const existing = prevAsRecord[k];
          next[k] = typeof existing === 'number' ? existing + v : v;
        } else {
          next[k] = v;
        }
      }
      return next as unknown as TaxFormData;
    });
  }

  function handleAuditEntry(entry: ImportAuditEntry) {
    setAuditEntries((prev) => [entry, ...prev]);
    // Refresh the sidebar so the new doc shows up
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  }

  function handleRemoveAudit(id: string) {
    setAuditEntries((prev) => {
      const removed = prev.find((e) => e.id === id);
      if (!removed) return prev;
      // Subtract the totals it had applied
      setForm((f) => {
        const fAsRecord = f as unknown as Record<string, unknown>;
        const next: Record<string, unknown> = { ...fAsRecord };
        for (const [k, v] of Object.entries(removed.appliedTotals)) {
          if (typeof v === 'number') {
            const existing = fAsRecord[k];
            if (typeof existing === 'number') {
              next[k] = Math.max(0, existing - v);
            }
          }
        }
        return next as unknown as TaxFormData;
      });
      return prev.filter((e) => e.id !== id);
    });
  }

  async function handleImportFromHeartland() {
    setImporting(true);
    setImportMsg(null);
    try {
      const resp = await api.get<{
        importedFields: {
          totalRevenue?: number;
          salesTaxCollected?: number;
          cogs?: number;
          endingInventory?: number;
        };
        metadata: {
          ticketCount: number;
          daysWithSales: number;
          netSales: number | null;
          netMargin: number | null;
          avgMarginPct: number | null;
          cogsEstimate: number | null;
          endingInventoryCost: number | null;
          totalDiscounts: number;
          reportingDataAvailable: boolean;
          inventoryDataAvailable: boolean;
        };
        note: string;
        docPersisted?: boolean;
        docId?: string;
      }>('/pos/import-tax-defaults', { params: { taxYear: form.taxYear } });

      const fields = resp.data.importedFields;
      const meta = resp.data.metadata;

      setForm((prev) => {
        const next = { ...prev };
        if (fields.totalRevenue !== undefined) next.totalRevenue = fields.totalRevenue;
        if (fields.salesTaxCollected !== undefined) next.salesTaxCollected = fields.salesTaxCollected;
        // Only fill COGS if currently empty (don't clobber a value the user
        // typed or that was extracted from a P&L).
        if (
          fields.cogs !== undefined &&
          fields.cogs > 0 &&
          (prev.cogs === undefined || prev.cogs === 0)
        ) {
          next.cogs = fields.cogs;
        }
        if (
          fields.endingInventory !== undefined &&
          fields.endingInventory > 0 &&
          (prev.endingInventory === undefined || prev.endingInventory === 0)
        ) {
          next.endingInventory = fields.endingInventory;
        }
        return next;
      });

      // Refresh documents sidebar / CPA package to show the new POS Import doc
      void queryClient.invalidateQueries({ queryKey: ['documents'] });

      // Build a friendly multi-line summary so the owner sees what came in
      const lines: string[] = [];
      if (fields.totalRevenue !== undefined) {
        lines.push(
          `Revenue: $${fields.totalRevenue.toLocaleString()}${meta.reportingDataAvailable ? ' (net sales)' : ' (reverse-calculated from gross)'}`
        );
      }
      if (fields.salesTaxCollected !== undefined) {
        lines.push(`Sales tax collected: $${fields.salesTaxCollected.toLocaleString()}`);
      }
      if (fields.cogs !== undefined && fields.cogs > 0) {
        lines.push(
          `COGS: $${fields.cogs.toLocaleString()}${
            meta.avgMarginPct != null ? ` (avg margin ${meta.avgMarginPct}%)` : ''
          }`
        );
      }
      if (fields.endingInventory !== undefined && fields.endingInventory > 0) {
        lines.push(`Ending inventory cost: $${fields.endingInventory.toLocaleString()}`);
      }
      lines.push(`${meta.ticketCount.toLocaleString()} transactions across ${meta.daysWithSales} sales days.`);
      if (resp.data.docPersisted) {
        lines.push('A "POS Import" record was saved to your documents and will be included in the CPA package.');
      }
      setImportMsg(lines.join(' · '));
    } catch (err) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? (err as Error).message;
      setImportMsg(`Import failed: ${message}`);
    } finally {
      setImporting(false);
    }
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!form.taxYear || form.taxYear < 2000 || form.taxYear > 2099) {
      errs['taxYear'] = 'Tax year must be between 2000 and 2099';
    }
    if (form.totalRevenue === undefined || form.totalRevenue < 0) {
      errs['totalRevenue'] = 'Total revenue is required';
    }
    if (form.cogs === undefined || form.cogs < 0) {
      errs['cogs'] = 'COGS is required';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    onSubmit(form);
  }

  const isPassThrough =
    form.entityType === 'LLC' ||
    form.entityType === 'S-Corp' ||
    form.entityType === 'Sole Proprietorship' ||
    form.entityType === 'Partnership' ||
    form.entityType === 'Multi-Member LLC';

  const isSCorp = form.entityType === 'S-Corp';

  return (
    <form onSubmit={handleSubmit} className="space-y-1">
      {/* Document upload */}
      <DocumentUpload onExtracted={handleExtracted} onAuditEntry={handleAuditEntry} />

      {/* Import audit trail — visible only after at least one statement upload */}
      {auditEntries.length > 0 && (
        <div className="mt-3">
          <ImportAuditPanel
            entries={auditEntries}
            onRemove={handleRemoveAudit}
          />
        </div>
      )}

      {/* Heartland POS import bar */}
      <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4 flex items-start justify-between gap-4">
        <div className="flex-1">
          <p className="text-sm font-medium text-blue-900">
            Import from Heartland POS
          </p>
          <p className="text-xs text-blue-700 mt-0.5">
            Pulls tax year {form.taxYear} from your synced Heartland data: net sales,
            sales tax, COGS estimate (from net margin), and ending inventory cost when
            available. A "POS Import" record is saved to your documents and bundled
            into the CPA package automatically.
          </p>
          {importMsg && (
            <p className="text-xs text-blue-900 mt-2 font-medium whitespace-pre-line">{importMsg}</p>
          )}
        </div>
        <button
          type="button"
          onClick={handleImportFromHeartland}
          disabled={importing}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition whitespace-nowrap"
        >
          {importing ? 'Importing…' : 'Import from POS'}
        </button>
      </div>

      {/* Section 1: Business Profile */}
      <Section
        title="Business Profile"
        description="Basic information about your business and tax filing"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberInput
            label="Tax Year"
            value={form.taxYear}
            onChange={(v) => update('taxYear', v ?? 2026)}
            min={2000}
            step={1}
            required
            help="The calendar year you're filing taxes for. For a 2026 return filed in early 2027, enter 2026. Calendar-year filers use the standard year; fiscal-year filers use the year their fiscal year ends."
          />
          <Select<EntityType>
            label="Business Entity Type"
            value={form.entityType}
            onChange={(v) => update('entityType', v)}
            options={[
              { value: 'LLC', label: 'Single-Member LLC' },
              { value: 'S-Corp', label: 'S-Corporation' },
              { value: 'Sole Proprietorship', label: 'Sole Proprietorship' },
              { value: 'Partnership', label: 'Partnership' },
              { value: 'Multi-Member LLC', label: 'Multi-Member LLC' },
            ]}
            required
            help="Your IRS-recognized entity type. Found on your EIN confirmation letter (Form CP-575) or prior year tax return. Affects which forms you file and self-employment tax treatment."
          />
          <Select<FilingStatus>
            label="Personal Filing Status"
            value={form.filingStatus}
            onChange={(v) => update('filingStatus', v)}
            options={[
              { value: 'single', label: 'Single' },
              { value: 'marriedFilingJointly', label: 'Married Filing Jointly' },
              { value: 'headOfHousehold', label: 'Head of Household' },
            ]}
            help="Your personal 1040 filing status. Pass-through business income flows to your personal return, so this affects QBI thresholds and standard deduction. 2026 QBI phase-out: $201,750 single / $403,500 MFJ."
          />
          <NumberInput
            label="Ownership Percent"
            value={form.ownershipPercent}
            onChange={(v) => update('ownershipPercent', v ?? 100)}
            min={0}
            step={0.1}
            hint="Your ownership stake (100% for sole owner)"
            help="Your percentage ownership in the business. 100 if you own it alone. For multi-member LLCs and partnerships, this comes from your Operating Agreement or Schedule K-1."
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <Toggle
            label="Franchise business"
            value={form.isFranchise}
            onChange={(v) => update('isFranchise', v)}
            hint="Royalty fees and ad fund are deductible"
            help="Toggle on if you operate under a franchise agreement (Foot Solutions, etc.). Unlocks fields for royalty fees, ad fund contributions, and initial franchise fee amortization (Section 197, 15-year)."
          />
          <Toggle
            label="Retail business"
            value={form.isRetail}
            onChange={(v) => update('isRetail', v)}
            hint="Qualifies for Texas reduced 0.375% franchise tax rate"
            help="Toggle on if more than 50% of revenue is from retail sales (NAICS 44–45). Foot Solutions qualifies. Reduces TX franchise tax rate from 0.75% to 0.375%."
          />
          <Toggle
            label="Operates in multiple states"
            value={form.isMultiState}
            onChange={(v) => update('isMultiState', v)}
            hint="Apportionment may apply"
            help="Toggle on if you have nexus in states beyond Texas (employees, inventory, or significant sales). Triggers apportionment calculations. Texas alone for most single-location franchises."
          />
        </div>
      </Section>

      {/* Section 2: Income */}
      <Section title="Income & Cost of Goods Sold">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberInput
            label="Total Annual Revenue"
            value={form.totalRevenue}
            onChange={(v) => update('totalRevenue', v ?? 0)}
            prefix="$"
            required
            help="Gross sales for the year, BEFORE sales tax. From your P&L statement (top line) or Heartland POS sales report. Use the 'Import from POS' button above to auto-fill from your payment history."
            sources={sourcesFor('totalRevenue')}
          />
          <NumberInput
            label="Cost of Goods Sold (COGS)"
            value={form.cogs}
            onChange={(v) => update('cogs', v ?? 0)}
            prefix="$"
            required
            help="What you paid for the products you sold. Formula: Beginning Inventory + Purchases − Ending Inventory. From your P&L (under COGS line) or Heartland Reporting → Cost of Sales report. Critical for federal taxable income and TX franchise margin."
            sources={sourcesFor('cogs')}
          />
          {form.isRetail && (
            <>
              <NumberInput
                label="Beginning Inventory"
                value={form.beginningInventory}
                onChange={(v) => update('beginningInventory', v)}
                prefix="$"
                hint="Inventory value at start of year"
                help="Total wholesale cost of all merchandise on hand on January 1. Should match your prior year's ending inventory. From Heartland: Reporting → Inventory Valuation report dated 12/31 of the prior year."
              />
              <NumberInput
                label="Ending Inventory"
                value={form.endingInventory}
                onChange={(v) => update('endingInventory', v)}
                prefix="$"
                hint="Inventory value at end of year"
                help="Total wholesale cost of all merchandise on hand on December 31. From Heartland: Reporting → Inventory Valuation report dated 12/31. Must reflect a physical count (or trusted perpetual inventory)."
              />
            </>
          )}
        </div>
      </Section>

      {/* Section 3: Operating Expenses */}
      <Section title="Operating Expenses">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberInput
            label="Total Operating Expenses"
            value={form.totalOperatingExpenses}
            onChange={(v) => update('totalOperatingExpenses', v ?? 0)}
            prefix="$"
            hint="Sum of all operating expenses"
            required
            help="Sum of ALL business expenses below excluding COGS. The total of rent, utilities, insurance, marketing, payroll, etc. From your P&L statement (Operating Expenses subtotal). The breakdown fields below help the AI categorize them correctly."
            sources={sourcesFor('totalOperatingExpenses')}
          />
          <NumberInput
            label="Rent / Lease Payments"
            value={form.rentLeasePayments}
            onChange={(v) => update('rentLeasePayments', v ?? 0)}
            prefix="$"
            help="Annual rent for your store location (and any equipment leases). From your lease agreement and bank statements. Fully deductible. Industry benchmark for retail footwear: ~5–12% of revenue."
            sources={sourcesFor('rentLeasePayments')}
          />
          <NumberInput
            label="Business Insurance Premiums"
            value={form.businessInsurancePremiums}
            onChange={(v) => update('businessInsurancePremiums', v ?? 0)}
            prefix="$"
            hint="General liability, property, workers comp (excludes owner's health/life)"
            help="Annual premiums for general liability, commercial property, workers comp, umbrella, and professional liability. From your insurance declarations pages or invoices. EXCLUDE owner's personal health, life, or disability — those go elsewhere or aren't deductible."
            sources={sourcesFor('businessInsurancePremiums')}
          />
          <NumberInput
            label="Utilities"
            value={form.utilities}
            onChange={(v) => update('utilities', v)}
            prefix="$"
            help="Annual electric, gas, water, internet, and phone for the business. From your utility bills or P&L. If your home office is part of this, only the business-use percentage is deductible there."
            sources={sourcesFor('utilities')}
          />
          <NumberInput
            label="Marketing & Advertising"
            value={form.marketingAdvertising}
            onChange={(v) => update('marketingAdvertising', v)}
            prefix="$"
            hint="Excludes franchisor ad fund (separate field)"
            help="Local advertising, social media, Google Ads, signage, print, sponsorships. Do NOT include the Foot Solutions national ad fund — that goes in the Franchise section. From your bank/credit card statements categorized as marketing."
            sources={sourcesFor('marketingAdvertising')}
          />
          <NumberInput
            label="Professional Fees"
            value={form.professionalFees}
            onChange={(v) => update('professionalFees', v)}
            prefix="$"
            hint="Legal, CPA, consulting"
            help="Fees paid to lawyers, CPAs, bookkeepers, business consultants. Fully deductible. Tax prep fees ARE deductible for the business but NOT for personal returns. From invoices and bank statements."
            sources={sourcesFor('professionalFees')}
          />
          <NumberInput
            label="Office Supplies"
            value={form.officeSupplies}
            onChange={(v) => update('officeSupplies', v)}
            prefix="$"
            help="Pens, paper, printer ink, packaging supplies — anything consumable used in operations. From bank/credit card statements. Items over $2,500 may need to be capitalized as equipment instead."
            sources={sourcesFor('officeSupplies')}
          />
          <NumberInput
            label="Software Subscriptions"
            value={form.softwareSubscriptions}
            onChange={(v) => update('softwareSubscriptions', v)}
            prefix="$"
            help="Annual cost of cloud software: Heartland POS subscription, QuickBooks, Microsoft 365, etc. From bank/credit card statements. Fully deductible as ordinary business expense."
            sources={sourcesFor('softwareSubscriptions')}
          />
          <NumberInput
            label="Bank & Merchant Fees"
            value={form.bankFees}
            onChange={(v) => update('bankFees', v)}
            prefix="$"
            hint="POS processing, bank account fees"
            help="Credit card processing fees (typically 2–4% of card sales), bank account fees, ACH fees. From your Global Payments / Heartland merchant statements and bank statements. Industry typical: 2.5–3.5% of card-based revenue."
            sources={sourcesFor('bankFees')}
          />
        </div>
      </Section>

      {/* Section 4: Conditional toggles */}
      <Section
        title="Additional Categories"
        description="Toggle on the categories that apply to your business"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Toggle
            label="Has W-2 employees"
            value={form.hasEmployees}
            onChange={(v) => update('hasEmployees', v)}
            help="Toggle on if you have any W-2 employees (not 1099 contractors). Includes part-time. Unlocks payroll fields. Required if you file Form 941 quarterly. From your payroll service (Gusto, ADP, etc.)."
          />
          <Toggle
            label="Pays 1099 contractors"
            value={form.hasContractors}
            onChange={(v) => update('hasContractors', v)}
            help="Toggle on if you paid any independent contractors $600+ during the year. Examples: cleaning service, photographer, freelance designer. Requires 1099-NEC filings. From your bank statements or 1099-NEC copies issued."
          />
          <Toggle
            label="Uses business vehicle"
            value={form.hasBusinessVehicle}
            onChange={(v) => update('hasBusinessVehicle', v)}
            help="Toggle on if you use any vehicle for business (running errands, deliveries, going to bank). Even occasional business use counts. Choose Standard Mileage method for simplicity."
          />
          <Toggle
            label="Has home office"
            value={form.hasHomeOffice}
            onChange={(v) => update('hasHomeOffice', v)}
            help="Toggle on if you regularly and exclusively use part of your home for business. Even with a retail location, you may qualify if you do bookkeeping, ordering, etc. from home. Simplified method: $5/sqft up to 300 sqft."
          />
          <Toggle
            label="Purchased equipment this year"
            value={form.hasEquipment}
            onChange={(v) => update('hasEquipment', v)}
            help="Toggle on if you bought any business equipment this year — foot scanners, 3D orthotics printer, POS hardware, furniture, computers. 2026 Section 179 limit is $2.56M with 100% bonus depreciation now permanent (OBBBA)."
          />
          <Toggle
            label="Has business loans"
            value={form.hasBusinessLoans}
            onChange={(v) => update('hasBusinessLoans', v)}
            help="Toggle on if you have any business debt: SBA loan, line of credit, equipment financing. Loan INTEREST is deductible; principal is not. Don't confuse with personal loans you used for the business."
          />
        </div>
      </Section>

      {/* Section 5: Payroll (conditional) */}
      {form.hasEmployees && (
        <Section title="Payroll">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NumberInput
              label="Number of Employees"
              value={form.employeeCount}
              onChange={(v) => update('employeeCount', v)}
              min={0}
              step={1}
              help="Total W-2 employees during the year, including part-time and seasonal. Should match the count on your W-3 form summary."
            />
            <NumberInput
              label="Total Employee Wages (W-2)"
              value={form.totalEmployeeWages}
              onChange={(v) => update('totalEmployeeWages', v)}
              prefix="$"
              help="Total gross wages paid to employees (Box 1 of W-2 forms summed). From your payroll provider's annual report or W-3. Excludes owner W-2 wages if you're an S-Corp (those go in Owner section)."
              sources={sourcesFor('totalEmployeeWages')}
            />
            <NumberInput
              label="Employer Payroll Taxes"
              value={form.employerPayrollTaxes}
              onChange={(v) => update('employerPayrollTaxes', v)}
              prefix="$"
              hint="FICA + FUTA + SUTA matching"
              help="Employer-paid portion of payroll taxes: Social Security 6.2%, Medicare 1.45%, FUTA, and Texas SUTA. From your Form 941 quarterly returns or payroll service annual summary."
              sources={sourcesFor('employerPayrollTaxes')}
            />
            <NumberInput
              label="Retirement Plan Contributions"
              value={form.retirementPlanContributions}
              onChange={(v) => update('retirementPlanContributions', v)}
              prefix="$"
              hint="Employer match to 401(k), SIMPLE, etc."
              help="Employer match contributions to employee retirement plans (401(k), SIMPLE IRA). From your retirement plan administrator. Owner contributions to your own plan go separately."
              sources={sourcesFor('retirementPlanContributions')}
            />
            <NumberInput
              label="Employer-Paid Employee Health Insurance"
              value={form.employerHealthInsurance}
              onChange={(v) => update('employerHealthInsurance', v)}
              prefix="$"
              help="Employer-paid health, dental, vision premiums for employees. From your insurance broker statements. Owner's premium goes in the Owner section, not here."
              sources={sourcesFor('employerHealthInsurance')}
            />
          </div>
        </Section>
      )}

      {/* Section 6: Contractors (conditional) */}
      {form.hasContractors && (
        <Section title="Contractor Payments">
          <NumberInput
            label="Total 1099-NEC Payments"
            value={form.total1099Payments}
            onChange={(v) => update('total1099Payments', v)}
            prefix="$"
            hint="Total paid to contractors during the year"
            help="Total paid to all 1099 contractors during the year. Sum of Box 1 from all 1099-NEC forms you issued. You must issue 1099-NEC for any contractor paid $600+."
            sources={sourcesFor('total1099Payments')}
          />
        </Section>
      )}

      {/* Section 7: Vehicle (conditional) */}
      {form.hasBusinessVehicle && (
        <Section title="Business Vehicle">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Deduction Method"
              value={form.vehicleMethod ?? 'standard_mileage'}
              onChange={(v) => update('vehicleMethod', v)}
              options={[
                { value: 'standard_mileage', label: 'Standard Mileage ($0.725/mi)' },
                { value: 'actual_expenses', label: 'Actual Expenses' },
              ]}
              help="Standard Mileage: $0.725/mi in 2026, requires only a mileage log. Actual: track all gas, repairs, depreciation but more record-keeping. You can switch methods year to year, but if you took bonus depreciation, you're locked into Actual."
            />
            <NumberInput
              label="Business Use Percent"
              value={form.businessUsePercent}
              onChange={(v) => update('businessUsePercent', v)}
              min={0}
              step={1}
              hint="What % of total miles are business"
              help="Of total miles driven this year, what percentage was for business? Personal commuting doesn't count as business. From your mileage log (e.g., MileIQ, Stride app, or written log)."
            />
            {form.vehicleMethod !== 'actual_expenses' && (
              <NumberInput
                label="Business Miles Driven"
                value={form.vehicleMilesDriven}
                onChange={(v) => update('vehicleMilesDriven', v)}
                hint="2026 IRS rate: $0.725 per mile"
                help="Total miles driven for business purposes during the year. From your mileage tracking app or written log. Required: date, destination, business purpose, and miles for each trip. The IRS requires contemporaneous records."
              />
            )}
            {form.vehicleMethod === 'actual_expenses' && (
              <NumberInput
                label="Actual Vehicle Expenses"
                value={form.actualVehicleExpenses}
                onChange={(v) => update('actualVehicleExpenses', v)}
                prefix="$"
                hint="Gas, maintenance, insurance, depreciation/lease"
                help="Total of all vehicle costs: gas, oil changes, repairs, insurance, registration, lease/depreciation. Only the business-use percentage is deductible. From your bank/credit card statements and receipts."
              />
            )}
          </div>
        </Section>
      )}

      {/* Section 8: Home Office (conditional) */}
      {form.hasHomeOffice && (
        <Section title="Home Office">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Deduction Method"
              value={form.homeOfficeMethod ?? 'simplified'}
              onChange={(v) => update('homeOfficeMethod', v)}
              options={[
                { value: 'simplified', label: 'Simplified ($5/sqft, max 300)' },
                { value: 'actual', label: 'Actual Expenses' },
              ]}
              help="Simplified: $5/sqft up to 300sqft = max $1,500. Actual: deduct business-use % of mortgage interest, utilities, depreciation, etc. — bigger deduction but more paperwork. Most small businesses use Simplified."
            />
            <NumberInput
              label="Home Office Square Footage"
              value={form.homeOfficeSqFt}
              onChange={(v) => update('homeOfficeSqFt', v)}
              hint={form.homeOfficeMethod === 'simplified' ? 'Capped at 300 sqft' : ''}
              help="Square footage used regularly and exclusively for business. Must be a clearly defined area — a desk in the corner of your bedroom doesn't count, but a dedicated room does. Measure or estimate based on your home's floor plan."
            />
            <NumberInput
              label="Total Home Square Footage"
              value={form.totalHomeSqFt}
              onChange={(v) => update('totalHomeSqFt', v)}
              hint="Used to calculate business-use percentage"
              help="Total square footage of your home (all rooms). Used to calculate the business-use percentage for the Actual method. From your home's appraisal, blueprint, or property tax assessment."
            />
            {form.homeOfficeMethod === 'actual' && (
              <NumberInput
                label="Actual Home Office Expenses"
                value={form.homeOfficeActualExpenses}
                onChange={(v) => update('homeOfficeActualExpenses', v)}
                prefix="$"
                hint="Utilities, mortgage interest, depreciation (business %)"
                help="Total of mortgage interest, property tax, utilities, repairs, depreciation, and home insurance — multiplied by your business-use percentage. Form 8829 walks you through this. Most owners find Simplified easier."
              />
            )}
          </div>
        </Section>
      )}

      {/* Section 9: Equipment (conditional) */}
      {form.hasEquipment && (
        <Section
          title="Equipment & Depreciation"
          description="2026: Section 179 limit $2.56M, 100% bonus depreciation permanent"
        >
          <NumberInput
            label="Total Equipment Cost This Year"
            value={form.totalEquipmentCost}
            onChange={(v) => update('totalEquipmentCost', v)}
            prefix="$"
            hint="Foot scanners, 3D orthotics printer, POS, furniture, etc."
            help="Total cost of all business equipment purchased this year (or financed and placed in service this year). 100% bonus depreciation is now permanent under OBBBA, so you can typically deduct the full amount in year one. From purchase receipts and asset register."
            sources={sourcesFor('totalEquipmentCost')}
          />
        </Section>
      )}

      {/* Section 10: Franchise (conditional) */}
      {form.isFranchise && (
        <Section title="Franchise (Foot Solutions)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NumberInput
              label="Royalty Fees Paid"
              value={form.royaltyFees}
              onChange={(v) => {
                if (v === undefined || v === 0) {
                  // Cleared — let auto-calc take over again on next revenue change.
                  manuallyEditedRef.current.delete('royaltyFees');
                } else {
                  manuallyEditedRef.current.add('royaltyFees');
                }
                update('royaltyFees', v);
              }}
              prefix="$"
              hint={`Auto-calculated as ${(ROYALTY_RATE * 100).toFixed(0)}% of revenue per FDD — edit if your actual royalty differs`}
              help="Total royalty fees paid to Foot Solutions corporate this year. Per the Foot Solutions FDD, royalties are 5% of gross sales — this field auto-fills from Total Revenue. Override only if your actual paid amount differs (e.g., partial-year openings). From your monthly Foot Solutions royalty statements. Fully deductible as ordinary business expense."
              sources={sourcesFor('royaltyFees')}
            />
            <NumberInput
              label="Advertising Fund Contributions"
              value={form.adFundContributions}
              onChange={(v) => {
                if (v === undefined || v === 0) {
                  manuallyEditedRef.current.delete('adFundContributions');
                } else {
                  manuallyEditedRef.current.add('adFundContributions');
                }
                update('adFundContributions', v);
              }}
              prefix="$"
              hint={`Auto-calculated as ${(AD_FUND_RATE * 100).toFixed(0)}% of revenue — edit if your actual contributions differ`}
              help="National ad fund contributions to Foot Solutions corporate. Typically 2% of gross sales — this field auto-fills from Total Revenue. Separate from local marketing. From your Foot Solutions royalty statements. Fully deductible."
              sources={sourcesFor('adFundContributions')}
            />
            <NumberInput
              label="Initial Franchise Fee Paid This Year"
              value={form.initialFranchiseFeePaidThisYear}
              onChange={(v) => update('initialFranchiseFeePaidThisYear', v)}
              prefix="$"
              hint="Amortized over 15 years (Section 197)"
              help="Only fill this in if you PURCHASED or RENEWED the franchise this year. The initial franchise fee is a Section 197 intangible — amortized over 15 years (not deducted upfront). From your franchise purchase agreement."
            />
          </div>
        </Section>
      )}

      {/* Section 11: Loans (conditional) */}
      {form.hasBusinessLoans && (
        <Section title="Business Loans">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NumberInput
              label="Loan Interest Paid"
              value={form.loanInterestPaid}
              onChange={(v) => update('loanInterestPaid', v)}
              prefix="$"
              hint="Deductible business expense"
              help="Total interest paid on all business loans this year. From your loan statements (look for 'Interest Paid YTD'). Fully deductible. The principal portion is NOT deductible."
              sources={sourcesFor('loanInterestPaid')}
            />
            <NumberInput
              label="Loan Principal Paid"
              value={form.loanPrincipalPaid}
              onChange={(v) => update('loanPrincipalPaid', v)}
              prefix="$"
              hint="NOT deductible (informational only)"
              help="Principal payments on business loans (informational — not deductible). Tracked here so the AI can flag your debt repayment activity. From loan statements."
              sources={sourcesFor('loanPrincipalPaid')}
            />
          </div>
        </Section>
      )}

      {/* Section 12: Sales Tax (conditional on retail) */}
      {form.isRetail && (
        <Section
          title="Texas Sales Tax (Denton — 8.25%)"
          description="State 6.25% + City of Denton 1.5% + DCTA 0.5%"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NumberInput
              label="Sales Tax Collected"
              value={form.salesTaxCollected}
              onChange={(v) => update('salesTaxCollected', v)}
              prefix="$"
              hint="From customers throughout the year"
              help="Total sales tax collected from customers during the year. Auto-filled by 'Import from POS' button (reverse-calculated from gross at 8.25%). For exact figures, sum the tax amounts from your Heartland sales tax report."
              sources={sourcesFor('salesTaxCollected')}
            />
            <NumberInput
              label="Sales Tax Already Remitted"
              value={form.salesTaxRemitted}
              onChange={(v) => update('salesTaxRemitted', v)}
              prefix="$"
              hint="Already paid to TX Comptroller"
              help="Total sales tax already paid to the Texas Comptroller through monthly/quarterly sales tax returns. From your TX Comptroller WebFile account or sales tax return copies."
              sources={sourcesFor('salesTaxRemitted')}
            />
          </div>
        </Section>
      )}

      {/* Section 13: Multi-state (conditional) */}
      {form.isMultiState && (
        <Section title="Multi-State Apportionment">
          <NumberInput
            label="Out-of-State Revenue Percent"
            value={form.outOfStateRevenuePercent}
            onChange={(v) => update('outOfStateRevenuePercent', v)}
            min={0}
            step={0.1}
            hint="% of revenue from outside Texas"
            help="Percentage of revenue generated from customers/operations outside Texas. Triggers TX franchise tax apportionment. From your sales records segmented by ship-to state, or POS reports filtered by location."
          />
        </Section>
      )}

      {/* Section 14: Owner / Pass-through */}
      {isPassThrough && (
        <Section
          title="Owner / Pass-Through Specifics"
          description="Required for accurate self-employment tax and QBI deduction calculation"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NumberInput
              label="Owner Health Insurance Premiums"
              value={form.ownerHealthInsurancePremiums}
              onChange={(v) => update('ownerHealthInsurancePremiums', v ?? 0)}
              prefix="$"
              hint="Self-employed deductible above the line"
              help="Annual premiums for your own health insurance (and family). Self-employed health insurance is deductible above-the-line on Form 1040 — not as a business expense. From your insurance billing statements."
              sources={sourcesFor('ownerHealthInsurancePremiums')}
            />
            {isSCorp && (
              <>
                <NumberInput
                  label="Owner W-2 Compensation (S-Corp)"
                  value={form.ownerCompensation}
                  onChange={(v) => update('ownerCompensation', v)}
                  prefix="$"
                  hint="Reasonable comp for retail S-Corp owner: $45K–$95K"
                  help="Your W-2 wages from the S-Corp. The IRS requires 'reasonable compensation' for S-Corp owner-employees. For retail footwear owner-operators: $45K–$95K range, median ~$65K. Setting this too low and taking large distributions instead is the #1 S-Corp audit trigger."
                />
                <NumberInput
                  label="Owner Distributions"
                  value={form.ownerDistributions}
                  onChange={(v) => update('ownerDistributions', v)}
                  prefix="$"
                  hint="Non-wage profit distributions"
                  help="Non-wage profit distributions you took from the S-Corp this year. Not subject to self-employment tax (which is the main S-Corp benefit). From your accountant's K-1 or your S-Corp distribution log."
                />
              </>
            )}
          </div>
        </Section>
      )}

      {/* Section 15: Standards toggle */}
      <Section
        title="Calculation Preferences"
        description="When enabled, the AI applies all 2026 standard rates and limits automatically"
      >
        <Toggle
          label="Calculate by Standards (recommended)"
          value={form.useStandards}
          onChange={(v) => update('useStandards', v)}
          hint="Applies IRS mileage $0.725/mi, Section 179 $2.56M, QBI 23%, Denton sales tax 8.25%, TX retail rate 0.375%, and OBBBA 100% bonus depreciation"
          help="Recommended for most users. Auto-applies all 2026 standard rates. Turn off only if you have specific reasons to use non-standard methods (rare for retail franchise)."
        />
      </Section>

      {/* Validation errors */}
      {Object.keys(errors).length > 0 && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 mt-4">
          <p className="text-sm font-medium text-red-800 mb-1">
            Please fix the following errors:
          </p>
          <ul className="text-sm text-red-700 list-disc pl-5">
            {Object.entries(errors).map(([key, msg]) => (
              <li key={key}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end gap-3 mt-6">
        <button
          type="button"
          onClick={() => {
            const ok = window.confirm(
              'Reset all form fields back to defaults? This will clear your saved draft and any uploaded statement totals.'
            );
            if (ok) {
              setForm({ ...DEFAULT_FORM });
              setAuditEntries([]);
              setImportMsg(null);
              setErrors({});
              try {
                window.localStorage.removeItem(DRAFT_STORAGE_KEY);
              } catch {
                // ignore
              }
            }
          }}
          disabled={loading}
          className="px-4 py-2.5 border border-slate-300 text-slate-700 rounded-md font-medium hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          Reset Form
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition"
        >
          {loading ? 'Analyzing…' : 'Analyze Tax Data'}
        </button>
      </div>
    </form>
  );
});
