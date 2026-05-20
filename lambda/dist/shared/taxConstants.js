"use strict";
/**
 * 2026 Federal & Texas Tax Constants
 *
 * Single source of truth for all tax rates, thresholds, and limits.
 * Sourced from IRS Notice 2026-10, OBBBA (signed July 2025), and TX Comptroller.
 *
 * Update this file when new tax year guidance is published.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FOOT_SOLUTIONS = exports.RETAIL_FOOTWEAR_BENCHMARKS = exports.TEXAS = exports.FEDERAL = exports.TAX_YEAR = void 0;
exports.TAX_YEAR = 2026;
// ── Federal ────────────────────────────────────────────────────────────
exports.FEDERAL = {
    // IRS Notice 2026-10 — effective Jan 1, 2026
    standardMileageRate: 0.725, // $/mile, business use
    // Section 179 (OBBBA permanent expansion)
    section179: {
        maxDeduction: 2560000,
        phaseOutStart: 4090000,
        phaseOutEnd: 6650000,
        maxSuvDeduction: 30500, // 6,000 lb GVW exception
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
            single: { start: 201750, end: 251750 },
            marriedFilingJointly: { start: 403500, end: 503500 },
        },
    },
    // Self-employment tax (FICA)
    selfEmploymentTax: {
        socialSecurityRate: 0.124, // 12.4% on earnings up to wage base
        medicareRate: 0.029, // 2.9% on all earnings
        additionalMedicareRate: 0.009, // 0.9% on wages above thresholds
        socialSecurityWageBase2026: 176100,
        additionalMedicareThreshold: { single: 200000, marriedFilingJointly: 250000 },
        deductibleSelfEmploymentRate: 0.5, // 1/2 of SE tax deductible above the line
    },
    // Home office — simplified method
    homeOffice: {
        simplifiedRatePerSqFt: 5,
        simplifiedMaxSqFt: 300,
        simplifiedMaxDeduction: 1500,
    },
    // Franchise fee amortization (Section 197 intangible)
    section197AmortizationYears: 15,
    // Self-employed retirement contribution limits (2026)
    retirement: {
        sepIra: { maxContribution: 70000, percentOfCompensation: 0.25 },
        solo401kEmployee: 23500, // < age 50
        solo401kCatchUp50Plus: 7500,
        solo401kEmployer: 0.25, // percent of compensation
        solo401kTotalCap: 70000,
        simpleIra: { maxContribution: 16500, catchUp50Plus: 3500 },
    },
    // Federal income tax brackets — 2026 single filer (reference for estimated tax)
    brackets2026Single: [
        { upTo: 11925, rate: 0.10 },
        { upTo: 48475, rate: 0.12 },
        { upTo: 103350, rate: 0.22 },
        { upTo: 197300, rate: 0.24 },
        { upTo: 250525, rate: 0.32 },
        { upTo: 626350, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
    ],
    // Federal income tax brackets — 2026 married filing jointly
    brackets2026Mfj: [
        { upTo: 23850, rate: 0.10 },
        { upTo: 96950, rate: 0.12 },
        { upTo: 206700, rate: 0.22 },
        { upTo: 394600, rate: 0.24 },
        { upTo: 501050, rate: 0.32 },
        { upTo: 751600, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
    ],
    // Standard deduction 2026
    standardDeduction: {
        single: 16100,
        marriedFilingJointly: 32200,
        headOfHousehold: 24150,
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
exports.TEXAS = {
    // Sales tax (Denton County)
    salesTax: {
        state: 0.0625,
        cityOfDenton: 0.015,
        dctaTransit: 0.005,
        combined: 0.0825,
    },
    // Franchise tax (margin tax) — 2026/2027 report years
    franchiseTax: {
        noTaxDueThreshold: 2650000, // updated for 2026
        rateRetailWholesale: 0.00375, // 0.375% — Foot Solutions qualifies as retail
        rateOther: 0.0075, // 0.75%
        compensationDeductionCap: 480000, // per employee/officer
        ezComputation: {
            revenueThreshold: 20000000,
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
exports.RETAIL_FOOTWEAR_BENCHMARKS = {
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
        low: 45000,
        median: 65000,
        high: 95000,
    },
};
// ── Foot Solutions franchise specifics ─────────────────────────────────
exports.FOOT_SOLUTIONS = {
    naicsCode: '448210',
    royaltyPercent: 0.05, // 5% of gross sales (per FDD for Foot Solutions Flower Mound)
    typicalAdFundPercent: 0.02, // ~2% of gross sales
    classificationForFranchiseTax: 'retail', // qualifies for 0.375% rate
    initialFranchiseFeeAmortizationYears: 15, // Section 197 intangible
};
//# sourceMappingURL=taxConstants.js.map