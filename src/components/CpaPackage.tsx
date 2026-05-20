import { useState, useRef } from 'react';
import { Briefcase, FileDown, Paperclip, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import Spinner from './Spinner';
import { downloadZip, type ZipFile } from '../lib/zip';
import { buildCsvSections, csvNum, type CsvSection } from '../lib/csv';
import type { TaxFormData, PersistedDocument, TaxSession } from '../types';

interface Props {
  /** Pull a fresh form snapshot at click time (so we don't stale-render). */
  getFormData?: () => TaxFormData | undefined;
  /** Most recent calculation result, if any */
  recentSession?: TaxSession | null;
  /** All persisted docs (extracted + supporting), already loaded by parent */
  documents?: PersistedDocument[];
}

/**
 * "CPA Package" — lets the user upload supporting docs and download a single
 * zip containing the form snapshot, latest analysis, a manifest, and every
 * source document. Designed to be forwarded to a CPA wholesale.
 */
export default function CpaPackage({ getFormData, recentSession, documents }: Props) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<
    Array<{ name: string; status: 'uploading' | 'done' | 'error'; error?: string }>
  >([]);
  const [building, setBuilding] = useState<
    | { phase: 'idle' }
    | { phase: 'fetching'; total: number; done: number }
    | { phase: 'zipping' }
    | { phase: 'done' }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  // CPA recipient info (optional, included in README)
  const [cpaName, setCpaName] = useState('');
  const [cpaEmail, setCpaEmail] = useState('');
  const [businessNotes, setBusinessNotes] = useState('');

  const supportingDocs = (documents ?? []).filter(
    (d) => d.docType === 'cpa-supporting'
  );
  const extractedDocs = (documents ?? []).filter(
    (d) => d.docType !== 'cpa-supporting'
  );

  function inferContentTypeFromName(name: string): string {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      txt: 'text/plain',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  async function uploadOne(file: File) {
    const update = (next: { status: 'uploading' | 'done' | 'error'; error?: string }) =>
      setUploads((prev) =>
        prev.map((u) => (u.name === file.name ? { ...u, ...next } : u))
      );

    try {
      const contentType =
        file.type && file.type !== '' ? file.type : inferContentTypeFromName(file.name);

      // 1. Get presigned upload URL
      const urlResp = await api.post<{ uploadUrl: string; objectKey: string }>(
        '/documents/upload-url',
        {
          fileName: file.name,
          contentType,
          docType: 'cpa-supporting',
        }
      );

      // 2. Upload to S3 directly
      const putResp = await fetch(urlResp.data.uploadUrl, { method: 'PUT', body: file });
      if (!putResp.ok) throw new Error(`S3 upload failed: ${putResp.status}`);

      // 3. Register metadata (no AI extraction)
      await api.post('/documents/register-supporting', {
        objectKey: urlResp.data.objectKey,
        fileName: file.name,
        contentType,
      });

      update({ status: 'done' });
      // Refresh documents list
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err as Error).message;
      update({ status: 'error', error: msg });
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    setUploads((prev) => [
      ...prev,
      ...arr.map((f) => ({ name: f.name, status: 'uploading' as const })),
    ]);
    // Upload sequentially to avoid hammering the API
    for (const f of arr) {
      await uploadOne(f);
    }
  }

  async function deleteSupportingDoc(docId: string, fileName: string) {
    if (!window.confirm(`Remove "${fileName}" from the package?`)) return;
    try {
      await api.delete(`/documents/${docId}`);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err as Error).message;
      window.alert(`Failed to delete: ${msg}`);
    }
  }

  function buildReadme(formData: TaxFormData | undefined): string {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const taxYear = formData?.taxYear ?? new Date().getFullYear();
    const allDocs = documents ?? [];
    const lines: string[] = [];
    lines.push(`Foot Solutions — CPA Tax Package`);
    lines.push(`Generated: ${now} (Central Time)`);
    lines.push(`Tax Year: ${taxYear}`);
    if (cpaName) lines.push(`Prepared for: ${cpaName}${cpaEmail ? ` <${cpaEmail}>` : ''}`);
    lines.push('');
    lines.push('Business profile');
    lines.push('----------------');
    if (formData) {
      lines.push(`Entity type:        ${formData.entityType}`);
      lines.push(`Filing status:      ${formData.filingStatus}`);
      lines.push(`Sole owner:         ${formData.isSoleOwner ? 'Yes' : 'No'}`);
      lines.push(`Franchise:          ${formData.isFranchise ? 'Yes' : 'No'}`);
      lines.push(`Retail:             ${formData.isRetail ? 'Yes' : 'No'}`);
      lines.push(`Multi-state:        ${formData.isMultiState ? 'Yes' : 'No'}`);
      lines.push(`Has employees:      ${formData.hasEmployees ? 'Yes' : 'No'}`);
      lines.push(`Has contractors:    ${formData.hasContractors ? 'Yes' : 'No'}`);
      lines.push(`Has business loans: ${formData.hasBusinessLoans ? 'Yes' : 'No'}`);
      lines.push(`Ownership %:        ${formData.ownershipPercent}`);
    }
    lines.push('');
    lines.push('Files in this package');
    lines.push('---------------------');
    lines.push(`tax_summary.csv     — Form inputs (revenue, expenses, payroll, etc.)`);
    if (recentSession?.result) {
      lines.push(`tax_analysis.csv    — Most recent estimated calculation (AI-assisted)`);
    }
    lines.push(`manifest.csv        — Index of all source documents with applied totals`);
    lines.push(`documents/          — All ${allDocs.length} source documents (originals)`);
    if (businessNotes.trim()) {
      lines.push('');
      lines.push('Notes from business owner');
      lines.push('-------------------------');
      lines.push(businessNotes.trim());
    }
    lines.push('');
    lines.push('How this package was assembled');
    lines.push('------------------------------');
    lines.push(
      `Source documents (bank statements, P&L, royalty statements, etc.) were uploaded`
    );
    lines.push(
      `into a private, encrypted store. An AI assistant extracted line items into the`
    );
    lines.push(
      `tax form fields where possible. The owner reviewed flagged items and resolved`
    );
    lines.push(
      `or ignored them. Numbers in tax_summary.csv reflect those reviewed totals.`
    );
    lines.push('');
    lines.push(
      `IMPORTANT: AI extraction can miss entries or mis-categorize. Please verify`
    );
    lines.push(
      `against the source documents in the documents/ folder. The original PDFs are`
    );
    lines.push(`the authoritative record.`);
    return lines.join('\r\n');
  }

  function buildTaxSummaryCsv(formData: TaxFormData | undefined): string {
    if (!formData) return 'No form data captured.';
    const sections: CsvSection[] = [];
    sections.push({
      title: 'Foot Solutions — Tax Year ' + formData.taxYear,
      subtitle: `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
      headers: ['Field', 'Value'],
      rows: [
        ['Entity Type', formData.entityType],
        ['Filing Status', formData.filingStatus],
        ['Tax Year', formData.taxYear],
        ['Ownership %', formData.ownershipPercent],
        ['Multi-State', formData.isMultiState ? 'Yes' : 'No'],
      ],
    });
    sections.push({
      title: 'Income',
      headers: ['Field', 'Amount (USD)'],
      rows: [
        ['Total Revenue', csvNum(formData.totalRevenue)],
        ['Cost of Goods Sold', csvNum(formData.cogs)],
        ['Beginning Inventory', csvNum(formData.beginningInventory ?? 0)],
        ['Ending Inventory', csvNum(formData.endingInventory ?? 0)],
      ],
    });
    sections.push({
      title: 'Operating Expenses',
      headers: ['Field', 'Amount (USD)'],
      rows: [
        ['Total Operating Expenses', csvNum(formData.totalOperatingExpenses)],
        ['Rent / Lease Payments', csvNum(formData.rentLeasePayments)],
        ['Utilities', csvNum(formData.utilities ?? 0)],
        ['Business Insurance Premiums', csvNum(formData.businessInsurancePremiums)],
        ['Professional Fees', csvNum(formData.professionalFees ?? 0)],
        ['Marketing / Advertising', csvNum(formData.marketingAdvertising ?? 0)],
        ['Office Supplies', csvNum(formData.officeSupplies ?? 0)],
        ['Bank Fees', csvNum(formData.bankFees ?? 0)],
        ['Software Subscriptions', csvNum(formData.softwareSubscriptions ?? 0)],
      ],
    });
    if (formData.hasEmployees) {
      sections.push({
        title: 'Payroll',
        headers: ['Field', 'Amount (USD)'],
        rows: [
          ['Employee Count', String(formData.employeeCount ?? '')],
          ['Total Wages', csvNum(formData.totalEmployeeWages ?? 0)],
          ['Employer Payroll Taxes', csvNum(formData.employerPayrollTaxes ?? 0)],
          ['Retirement Plan Contributions', csvNum(formData.retirementPlanContributions ?? 0)],
          ['Employer Health Insurance', csvNum(formData.employerHealthInsurance ?? 0)],
        ],
      });
    }
    if (formData.hasContractors) {
      sections.push({
        title: 'Contractors',
        headers: ['Field', 'Amount (USD)'],
        rows: [['Total 1099 Payments', csvNum(formData.total1099Payments ?? 0)]],
      });
    }
    if (formData.hasBusinessVehicle) {
      sections.push({
        title: 'Business Vehicle',
        headers: ['Field', 'Value'],
        rows: [
          ['Method', formData.vehicleMethod ?? ''],
          ['Miles Driven', String(formData.vehicleMilesDriven ?? '')],
          ['Actual Vehicle Expenses', csvNum(formData.actualVehicleExpenses ?? 0)],
          ['Business Use %', String(formData.businessUsePercent ?? '')],
        ],
      });
    }
    if (formData.hasHomeOffice) {
      sections.push({
        title: 'Home Office',
        headers: ['Field', 'Value'],
        rows: [
          ['Method', formData.homeOfficeMethod ?? ''],
          ['Office Sq Ft', String(formData.homeOfficeSqFt ?? '')],
          ['Total Home Sq Ft', String(formData.totalHomeSqFt ?? '')],
          ['Actual Expenses', csvNum(formData.homeOfficeActualExpenses ?? 0)],
        ],
      });
    }
    if (formData.hasEquipment && formData.fixedAssets && formData.fixedAssets.length > 0) {
      sections.push({
        title: 'Fixed Assets',
        headers: ['Description', 'Cost (USD)', 'Placed in Service', 'Method'],
        rows: formData.fixedAssets.map((a) => [a.description, csvNum(a.cost), a.placedInServiceDate, a.method]),
      });
    }
    if (formData.isFranchise) {
      sections.push({
        title: 'Franchise',
        headers: ['Field', 'Amount (USD)'],
        rows: [
          ['Royalty Fees', csvNum(formData.royaltyFees ?? 0)],
          ['Ad Fund Contributions', csvNum(formData.adFundContributions ?? 0)],
          ['Initial Franchise Fee Paid This Year', csvNum(formData.initialFranchiseFeePaidThisYear ?? 0)],
        ],
      });
    }
    if (formData.hasBusinessLoans) {
      sections.push({
        title: 'Business Loans',
        headers: ['Field', 'Amount (USD)'],
        rows: [
          ['Loan Interest Paid', csvNum(formData.loanInterestPaid ?? 0)],
          ['Loan Principal Paid', csvNum(formData.loanPrincipalPaid ?? 0)],
        ],
      });
    }
    sections.push({
      title: 'Sales Tax',
      headers: ['Field', 'Amount (USD)'],
      rows: [
        ['Sales Tax Collected', csvNum(formData.salesTaxCollected ?? 0)],
        ['Sales Tax Remitted', csvNum(formData.salesTaxRemitted ?? 0)],
      ],
    });
    sections.push({
      title: 'Owner',
      headers: ['Field', 'Value'],
      rows: [
        ['Ownership %', String(formData.ownershipPercent)],
        ['Owner Health Insurance Premiums', csvNum(formData.ownerHealthInsurancePremiums)],
        ['Owner Compensation', csvNum(formData.ownerCompensation ?? 0)],
        ['Owner Distributions', csvNum(formData.ownerDistributions ?? 0)],
      ],
    });
    return buildCsvSections(sections);
  }

  function buildAnalysisCsv(): string | null {
    if (!recentSession?.result) return null;
    const r = recentSession.result;
    const sections: CsvSection[] = [
      {
        title: `Estimated Tax Analysis — ${recentSession.taxYear}`,
        subtitle: `Generated ${new Date(recentSession.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · AI-assisted estimate, not professional tax advice`,
        headers: ['Metric', 'Amount (USD)'],
        rows: [
          ['Estimated Federal Taxable Income', csvNum(r.estimatedFederalTaxableIncome)],
          ['Estimated Federal Tax Liability', csvNum(r.estimatedFederalTaxLiability)],
          ['Estimated Self-Employment Tax', csvNum(r.estimatedSelfEmploymentTax)],
          ['Estimated Texas Franchise Tax', csvNum(r.estimatedTexasFranchiseTax)],
          ['QBI Deduction', csvNum(r.qbiDeduction)],
          ['Estimated Sales Tax Owed', csvNum(r.estimatedSalesTaxOwed)],
        ],
      },
      {
        title: 'Texas Margin Method',
        headers: ['Metric', 'Value'],
        rows: [['Method Used', r.texasMarginMethodUsed]],
      },
      {
        title: 'Texas Margin Method Comparison',
        headers: ['Method', 'Margin (USD)', 'Tax (USD)'],
        rows: r.texasMarginMethodComparison.map((m) => [m.method, csvNum(m.margin), csvNum(m.tax)]),
      },
      {
        title: 'Estimated Quarterly Payments',
        headers: ['Quarter', 'Due Date', 'Amount (USD)'],
        rows: r.estimatedQuarterlyPayments.map((q) => [q.quarter, q.dueDate, csvNum(q.amount)]),
      },
      {
        title: 'Key Deductions Identified',
        headers: ['Item'],
        rows: r.keyDeductions.map((s) => [s]),
      },
      {
        title: 'Tax-Saving Opportunities',
        headers: ['Item'],
        rows: r.taxSavingOpportunities.map((s) => [s]),
      },
      {
        title: 'Flagged for CPA Review',
        headers: ['Item'],
        rows: r.flaggedForCPAReview.map((s) => [s]),
      },
      {
        title: 'Forms to File',
        headers: ['Form'],
        rows: r.formsToFile.map((s) => [s]),
      },
      {
        title: 'Year-over-Year Changes',
        headers: ['Note'],
        rows: r.yearOverYearChanges.map((s) => [s]),
      },
      {
        title: 'Owner Summary',
        rows: [[r.ownerSummary]],
      },
      {
        title: 'Disclaimer',
        rows: [[r.disclaimer]],
      },
    ];
    return buildCsvSections(sections);
  }

  function buildManifestCsv(): string {
    const sections: CsvSection[] = [
      {
        title: 'Source Documents Manifest',
        subtitle: `${(documents ?? []).length} document(s) included.`,
        headers: [
          'Filename in package',
          'Original filename',
          'Type',
          'Uploaded',
          'AI Confidence',
          'Bank/Source',
          'Period',
          'Applied Totals (key=amount)',
          'Flagged Count',
          'Notes',
        ],
        rows: (documents ?? []).map((d, i) => {
          const ext = d.fileName.includes('.') ? '.' + d.fileName.split('.').pop() : '';
          const safeName = `${String(i + 1).padStart(3, '0')}_${d.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}${d.fileName.includes('.') ? '' : ext}`;
          const period =
            d.periodStart || d.periodEnd
              ? `${d.periodStart ?? '?'} to ${d.periodEnd ?? '?'}`
              : '';
          const totalsStr = Object.entries(d.appliedTotals ?? {})
            .filter(([, v]) => typeof v === 'number' && (v as number) > 0)
            .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
            .join('; ');
          return [
            safeName,
            d.fileName,
            d.docType,
            d.uploadedAt,
            d.confidence ?? '',
            d.bankName ?? '',
            period,
            totalsStr,
            (d.flagged ?? []).length,
            d.notes ?? '',
          ];
        }),
      },
    ];
    return buildCsvSections(sections);
  }

  async function fetchDocBytes(
    docId: string
  ): Promise<{ bytes: Uint8Array; contentType: string; inlineExt?: string }> {
    const r = await api.get<{
      downloadUrl?: string;
      contentType?: string;
      inline?: boolean;
      content?: string;
      fileName?: string;
    }>(`/documents/${docId}/download-url`);
    // Synthetic doc — content embedded directly in the response
    if (r.data.inline && r.data.content) {
      const bytes = new TextEncoder().encode(r.data.content);
      return {
        bytes,
        contentType: r.data.contentType ?? 'application/json',
        inlineExt: r.data.contentType === 'application/json' ? '.json' : '.txt',
      };
    }
    if (!r.data.downloadUrl) {
      throw new Error('No download URL returned');
    }
    const resp = await fetch(r.data.downloadUrl);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: r.data.contentType ?? 'application/octet-stream',
    };
  }

  async function buildAndDownloadPackage() {
    const allDocs = documents ?? [];
    const formData = getFormData ? getFormData() : undefined;
    setBuilding({ phase: 'fetching', total: allDocs.length, done: 0 });

    try {
      const files: ZipFile[] = [];
      // 1) README
      files.push({ name: 'README.txt', data: buildReadme(formData) });
      // 2) Tax summary
      files.push({ name: 'tax_summary.csv', data: '\uFEFF' + buildTaxSummaryCsv(formData) });
      // 3) Tax analysis (if available)
      const analysis = buildAnalysisCsv();
      if (analysis) {
        files.push({ name: 'tax_analysis.csv', data: '\uFEFF' + analysis });
      }
      // 4) Manifest
      files.push({ name: 'manifest.csv', data: '\uFEFF' + buildManifestCsv() });

      // 5) Source documents — fetch in parallel but cap concurrency
      const concurrency = 4;
      const queue = [...allDocs];
      let done = 0;
      const errored: string[] = [];

      async function worker() {
        while (queue.length > 0) {
          const d = queue.shift();
          if (!d) return;
          try {
            const { bytes, inlineExt } = await fetchDocBytes(d.docId);
            const ext = d.fileName.includes('.')
              ? '.' + d.fileName.split('.').pop()
              : (inlineExt ?? '');
            const safeBase = (
              d.fileName.includes('.')
                ? d.fileName
                : d.fileName + ext
            ).replace(/[^A-Za-z0-9._-]+/g, '_');
            const idx = String(allDocs.indexOf(d) + 1).padStart(3, '0');
            files.push({
              name: `documents/${idx}_${safeBase}`,
              data: bytes,
            });
          } catch (err) {
            errored.push(`${d.fileName}: ${(err as Error).message}`);
          } finally {
            done++;
            setBuilding({ phase: 'fetching', total: allDocs.length, done });
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, worker));

      if (errored.length > 0) {
        files.push({
          name: 'documents/_download_errors.txt',
          data: errored.join('\r\n'),
        });
      }

      setBuilding({ phase: 'zipping' });
      const stamp = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
      }).format(new Date());
      const safeCpa = cpaName.trim() ? cpaName.trim().replace(/[^A-Za-z0-9-]+/g, '-') + '_' : '';
      downloadZip(`FootSolutions_CPA_Package_${safeCpa}${stamp}.zip`, files);
      setBuilding({ phase: 'done' });
      setTimeout(() => setBuilding({ phase: 'idle' }), 4000);
    } catch (err) {
      setBuilding({
        phase: 'error',
        message: (err as Error).message ?? 'Failed to build package',
      });
    }
  }

  return (
    <section
      aria-labelledby="cpa-package-heading"
      className="bg-white rounded-lg border border-slate-200 p-5"
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="rounded-lg bg-indigo-50 p-2 flex-shrink-0">
          <Briefcase className="w-5 h-5 text-indigo-600" />
        </div>
        <div className="min-w-0">
          <h2 id="cpa-package-heading" className="text-base font-semibold text-slate-900">
            CPA Package
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Bundle the tax form snapshot, latest analysis, and all uploaded documents
            into a single zip you can email to your CPA.
          </p>
        </div>
      </div>

      {/* Recipient + notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            CPA name (optional)
          </label>
          <input
            type="text"
            value={cpaName}
            onChange={(e) => setCpaName(e.target.value)}
            placeholder="Jane Doe, CPA"
            className="w-full text-sm border border-slate-300 rounded px-3 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            CPA email (optional)
          </label>
          <input
            type="email"
            value={cpaEmail}
            onChange={(e) => setCpaEmail(e.target.value)}
            placeholder="cpa@example.com"
            className="w-full text-sm border border-slate-300 rounded px-3 py-1.5"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Notes for the CPA (optional — included in README)
          </label>
          <textarea
            value={businessNotes}
            onChange={(e) => setBusinessNotes(e.target.value)}
            placeholder="Anything you want your CPA to know — open items, questions, year-over-year changes, etc."
            rows={3}
            className="w-full text-sm border border-slate-300 rounded px-3 py-2 resize-y"
          />
        </div>
      </div>

      {/* Supporting documents uploader */}
      <div className="rounded-md border border-dashed border-slate-300 p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-slate-700">
            Add supporting documents
          </h3>
          <span className="text-xs text-slate-400">
            No AI processing — just stored and bundled.
          </span>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Upload anything else useful for the CPA: prior-year returns, K-1s, depreciation schedules,
          mileage logs, lease addenda, etc. PDF, images, Word, Excel, CSV, plain text accepted.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => void handleFiles(e.target.files)}
          accept=".pdf,.csv,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.txt"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700"
        >
          <Paperclip className="w-3.5 h-3.5" />
          Choose files
        </button>

        {uploads.length > 0 && (
          <ul className="mt-3 space-y-1">
            {uploads.map((u) => (
              <li
                key={u.name}
                className="flex items-center justify-between text-xs px-2 py-1 rounded bg-slate-50"
              >
                <span className="truncate text-slate-700">{u.name}</span>
                {u.status === 'uploading' && (
                  <span className="flex items-center gap-1 text-slate-500">
                    <Spinner size="sm" /> uploading…
                  </span>
                )}
                {u.status === 'done' && (
                  <span className="text-emerald-600 font-medium">✓ uploaded</span>
                )}
                {u.status === 'error' && (
                  <span className="text-red-600" title={u.error}>
                    ✕ {u.error ?? 'failed'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {supportingDocs.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-slate-600 mb-1">
              {supportingDocs.length} supporting document
              {supportingDocs.length === 1 ? '' : 's'} attached:
            </p>
            <ul className="space-y-1">
              {supportingDocs.map((d) => (
                <li
                  key={d.docId}
                  className="flex items-center justify-between text-xs px-2 py-1 rounded border border-slate-100 bg-white"
                >
                  <span className="truncate text-slate-700" title={d.fileName}>
                    📎 {d.fileName}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteSupportingDoc(d.docId, d.fileName)}
                    className="text-slate-400 hover:text-red-600 flex-shrink-0 ml-2"
                    aria-label="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Package preview */}
      <div className="bg-slate-50 rounded-md p-3 text-xs text-slate-600 mb-4">
        <p className="font-medium text-slate-700 mb-1">Package will contain:</p>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>
            <strong>README.txt</strong> — business profile + index
          </li>
          <li>
            <strong>tax_summary.csv</strong> — current form values
          </li>
          {recentSession?.result && (
            <li>
              <strong>tax_analysis.csv</strong> — latest AI-assisted estimate
            </li>
          )}
          <li>
            <strong>manifest.csv</strong> — document index with applied totals
          </li>
          <li>
            <strong>documents/</strong> — {(documents ?? []).length} source file
            {(documents ?? []).length === 1 ? '' : 's'} ({extractedDocs.length} extracted +{' '}
            {supportingDocs.length} supporting)
          </li>
        </ul>
      </div>

      {/* Build button + progress */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void buildAndDownloadPackage()}
          disabled={
            building.phase === 'fetching' ||
            building.phase === 'zipping'
          }
          className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
        >
          <FileDown className="w-4 h-4" />
          {building.phase === 'fetching' ||
          building.phase === 'zipping'
            ? 'Building package…'
            : 'Download CPA package (.zip)'}
        </button>
        {building.phase === 'fetching' && (
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <Spinner size="sm" />
            Fetching {building.done} / {building.total} documents…
          </span>
        )}
        {building.phase === 'zipping' && (
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <Spinner size="sm" />
            Zipping…
          </span>
        )}
        {building.phase === 'done' && (
          <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
            ✓ Package downloaded
          </span>
        )}
        {building.phase === 'error' && (
          <span className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 inline-flex items-center gap-1.5">
            <X className="w-3 h-3" /> {building.message}
          </span>
        )}
      </div>
    </section>
  );
}
