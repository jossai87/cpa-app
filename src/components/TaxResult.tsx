import type { BedrockTaxResponse } from '../types';

interface Props {
  taxYear: number;
  result: BedrockTaxResponse;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'positive' | 'warning';
}) {
  const toneClasses =
    tone === 'positive'
      ? 'border-green-200 bg-green-50'
      : tone === 'warning'
        ? 'border-amber-200 bg-amber-50'
        : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border ${toneClasses} p-4`}>
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-semibold text-slate-900 mt-1">{value}</div>
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}

function Section({
  title,
  children,
  icon,
}: {
  title: string;
  children: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
        {icon && <span>{icon}</span>}
        {title}
      </h3>
      {children}
    </div>
  );
}

function BulletList({ items, tone = 'default' }: { items: string[]; tone?: 'default' | 'positive' | 'warning' }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-slate-500 italic">None</p>;
  }
  const toneClass =
    tone === 'positive' ? 'text-green-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-700';
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className={`text-sm ${toneClass} flex gap-2`}>
          <span className="flex-shrink-0">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function TaxResult({ taxYear, result }: Props) {
  return (
    <div className="space-y-4">
      {/* Owner summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-5">
        <div className="text-xs font-medium text-blue-700 uppercase tracking-wide mb-2">
          Tax Year {taxYear} Summary
        </div>
        <p className="text-sm text-slate-800 leading-relaxed">{result.ownerSummary}</p>
      </div>

      {/* Top metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="Federal Tax"
          value={fmt(result.estimatedFederalTaxLiability)}
          hint={`Income: ${fmt(result.estimatedFederalTaxableIncome)}`}
        />
        <MetricCard
          label="Self-Employment Tax"
          value={fmt(result.estimatedSelfEmploymentTax)}
          hint="15.3% on net SE earnings"
        />
        <MetricCard
          label="TX Franchise Tax"
          value={fmt(result.estimatedTexasFranchiseTax)}
          hint={`Method: ${result.texasMarginMethodUsed.replace(/_/g, ' ')}`}
          tone={result.estimatedTexasFranchiseTax === 0 ? 'positive' : 'default'}
        />
        <MetricCard
          label="Sales Tax Owed"
          value={fmt(result.estimatedSalesTaxOwed)}
          hint="Denton 8.25%"
        />
      </div>

      {/* QBI */}
      {result.qbiDeduction > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="text-xs font-medium text-green-700 uppercase tracking-wide">
            QBI Deduction (Section 199A — 23% per OBBBA)
          </div>
          <div className="text-xl font-semibold text-green-900 mt-1">
            {fmt(result.qbiDeduction)}
          </div>
        </div>
      )}

      {/* Quarterly payments */}
      <Section title="Estimated Quarterly Payments" icon="📅">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {result.estimatedQuarterlyPayments.map((q, i) => (
            <div key={i} className="rounded border border-slate-200 p-3">
              <div className="text-xs font-medium text-slate-500">{q.quarter}</div>
              <div className="text-lg font-semibold text-slate-900 mt-0.5">
                {fmt(q.amount)}
              </div>
              <div className="text-xs text-slate-500 mt-1">Due {q.dueDate}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* TX margin method comparison */}
      {result.texasMarginMethodComparison?.length > 0 && (
        <Section title="Texas Franchise Tax Method Comparison" icon="🔢">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 font-medium text-slate-600">Method</th>
                  <th className="text-right py-2 font-medium text-slate-600">Margin</th>
                  <th className="text-right py-2 font-medium text-slate-600">Tax</th>
                </tr>
              </thead>
              <tbody>
                {result.texasMarginMethodComparison.map((m, i) => {
                  const isUsed = m.method === result.texasMarginMethodUsed;
                  return (
                    <tr
                      key={i}
                      className={`border-b border-slate-100 ${
                        isUsed ? 'bg-green-50 font-medium' : ''
                      }`}
                    >
                      <td className="py-2 text-slate-700">
                        {m.method.replace(/_/g, ' ')}
                        {isUsed && (
                          <span className="ml-2 text-xs text-green-700">← used</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-slate-700">{fmt(m.margin)}</td>
                      <td className="py-2 text-right text-slate-700">{fmt(m.tax)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Two columns: deductions + opportunities */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Key Deductions Identified" icon="✓">
          <BulletList items={result.keyDeductions} tone="positive" />
        </Section>
        <Section title="Tax Saving Opportunities" icon="💡">
          <BulletList items={result.taxSavingOpportunities} tone="positive" />
        </Section>
      </div>

      {/* Two columns: flagged + forms */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Flagged for CPA Review" icon="⚠️">
          <BulletList items={result.flaggedForCPAReview} tone="warning" />
        </Section>
        <Section title="Forms to File" icon="📋">
          <BulletList items={result.formsToFile} />
        </Section>
      </div>

      {/* Year over year */}
      {result.yearOverYearChanges?.length > 0 && (
        <Section title="2026 Tax Law Changes (vs Prior Year)" icon="📈">
          <BulletList items={result.yearOverYearChanges} />
        </Section>
      )}

      {/* Disclaimer */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-600">
        <span className="font-medium">Disclaimer:</span> {result.disclaimer}
      </div>
    </div>
  );
}
