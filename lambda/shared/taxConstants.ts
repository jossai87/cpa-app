/**
 * 2026 Federal & Texas Tax Constants
 *
 * Single source of truth for all tax rates, thresholds, and limits.
 * Sourced from IRS Notice 2026-10, OBBBA (signed July 2025), and TX Comptroller.
 *
 * Update this file when new tax year guidance is published.
 */

export const TAX_YEAR = 2026;

// ── Federal ────────────────────────────────────────────────────────────

export const FEDERAL = {
  // IRS Notice 2026-10 — effective Jan 1, 2026
  standardMileageRate: 0.725, // $/mile, business use

  // Section 179 (OBBBA permanent expansion)
  section179: {
    maxDeduction: 2_560_000,
    phaseOutStart: 4_090_000,
    phaseOutEnd: 6_650_000,
    maxSuvDeduction: 30_500, // 6,000 lb GVW exception
  },

  // Bonus depreciation — OBBBA made 100% permanent for property placed in service after Jan 19, 2025
  bonusDepreciation: {
    rate: 1.0, // 100%
    permanent: true,
  },

  // Section 199A QBI — OBBBA increased to 23% and made permanent
  qbi: {
    rate: 0.23,
    permanent: true,
    thresholds: {
      single: { start: 201_750, end: 251_750 },
      marriedFilingJointly: { start: 403_500, end: 503_500 },
    },
  },

  // Self-employment tax (FICA)
  selfEmploymentTax: {
    socialSecurityRate: 0.124, // 12.4% on earnings up to wage base
    medicareRate: 0.029, // 2.9% on all earnings
    additionalMedicareRate: 0.009, // 0.9% on wages above thresholds
    socialSecurityWageBase2026: 176_100,
    additionalMedicareThreshold: { single: 200_000, marriedFilingJointly: 250_000 },
    deductibleSelfEmploymentRate: 0.5, // 1/2 of SE tax deductible above the line
  },

  // Home office — simplified method
  homeOffice: {
    simplifiedRatePerSqFt: 5,
    simplifiedMaxSqFt: 300,
    simplifiedMaxDeduction: 1_500,
  },

  // Franchise fee amortization (Section 197 intangible)
  section197AmortizationYears: 15,

  // Self-employed retirement contribution limits (2026)
  retirement: {
    sepIra: { maxContribution: 70_000, percentOfCompensation: 0.25 },
    solo401kEmployee: 23_500, // < age 50
    solo401kCatchUp50Plus: 7_500,
    solo401kEmployer: 0.25, // percent of compensation
    solo401kTotalCap: 70_000,
    simpleIra: { maxContribution: 16_500, catchUp50Plus: 3_500 },
  },

  // Federal income tax brackets — 2026 single filer (reference for estimated tax)
  brackets2026Single: [
    { upTo: 11_925, rate: 0.10 },
    { upTo: 48_475, rate: 0.12 },
    { upTo: 103_350, rate: 0.22 },
    { upTo: 197_300, rate: 0.24 },
    { upTo: 250_525, rate: 0.32 },
    { upTo: 626_350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],

  // Federal income tax brackets — 2026 married filing jointly
  brackets2026Mfj: [
    { upTo: 23_850, rate: 0.10 },
    { upTo: 96_950, rate: 0.12 },
    { upTo: 206_700, rate: 0.22 },
    { upTo: 394_600, rate: 0.24 },
    { upTo: 501_050, rate: 0.32 },
    { upTo: 751_600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],

  // Standard deduction 2026
  standardDeduction: {
    single: 16_100,
    marriedFilingJointly: 32_200,
    headOfHousehold: 24_150,
  },

  // Quarterly estimated tax due dates for tax year 2026
  estimatedTaxDueDates2026: [
    'April 15, 2026', // Q1
    'June 15, 2026', // Q2
    'September 15, 2026', // Q3
    'January 15, 2027', // Q4
  ],
};

// ── Texas ──────────────────────────────────────────────────────────────

export const TEXAS = {
  // Sales tax (Denton County)
  salesTax: {
    state: 0.0625,
    cityOfDenton: 0.015,
    dctaTransit: 0.005,
    combined: 0.0825,
  },

  // Franchise tax (margin tax) — 2026/2027 report years
  franchiseTax: {
    noTaxDueThreshold: 2_650_000, // updated for 2026
    rateRetailWholesale: 0.00375, // 0.375% — Foot Solutions qualifies as retail
    rateOther: 0.0075, // 0.75%
    compensationDeductionCap: 480_000, // per employee/officer
    ezComputation: {
      revenueThreshold: 20_000_000,
      rate: 0.00331, // 0.331%
    },
    annualReportDueDate: 'May 15',
    extendedReportDueDate: 'August 15',
    secondExtensionDueDate: 'November 15',
    marginMethods: [
      { id: 'revenue_minus_cogs', label: 'Total Revenue minus Cost of Goods Sold' },
      { id: 'revenue_minus_compensation', label: 'Total Revenue minus Compensation' },
      { id: '70_percent_revenue', label: '70% of Total Revenue' },
      { id: 'revenue_minus_1m', label: 'Total Revenue minus $1 million' },
    ],
  },

  // No state income tax for individuals or businesses
  hasStateIncomeTax: false,
};

// ── Industry benchmarks (IRS SOI / BLS data for retail footwear) ───────

export const RETAIL_FOOTWEAR_BENCHMARKS = {
  naicsCode: '448210', // Shoe Stores
  // Approximate ranges from IRS Statistics of Income (Schedule C / 1120-S)
  // for specialty retail in the $250K–$1M revenue band
  expenseRatios: {
    cogsPercent: { low: 0.45, typical: 0.55, high: 0.65 },
    rentPercent: { low: 0.05, typical: 0.08, high: 0.12 },
    payrollPercent: { low: 0.10, typical: 0.18, high: 0.25 },
    advertisingPercent: { low: 0.01, typical: 0.03, high: 0.06 },
    insurancePercent: { low: 0.005, typical: 0.015, high: 0.03 },
  },
  // Reasonable compensation range for owner-operator S-Corp (full-time)
  reasonableCompFullTime: {
    low: 45_000,
    median: 65_000,
    high: 95_000,
  },
};

// ── Foot Solutions franchise specifics ─────────────────────────────────

export const FOOT_SOLUTIONS = {
  naicsCode: '448210',
  royaltyPercent: 0.05, // 5% of gross sales (per FDD for Foot Solutions Flower Mound)
  typicalAdFundPercent: 0.02, // ~2% of gross sales
  classificationForFranchiseTax: 'retail', // qualifies for 0.375% rate
  initialFranchiseFeeAmortizationYears: 15, // Section 197 intangible
};
