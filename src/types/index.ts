/**
 * Frontend types — mirror lambda/shared/types.ts
 */

export type EntityType =
  | 'LLC'
  | 'S-Corp'
  | 'Sole Proprietorship'
  | 'Partnership'
  | 'Multi-Member LLC';

export type FilingStatus = 'single' | 'marriedFilingJointly' | 'headOfHousehold';

export type DepreciationMethod = 'section_179' | 'bonus_100' | 'macrs_5yr' | 'macrs_7yr';

export type VehicleMethod = 'standard_mileage' | 'actual_expenses';

export type HomeOfficeMethod = 'simplified' | 'actual';

export interface FixedAsset {
  description: string;
  cost: number;
  placedInServiceDate: string;
  method: DepreciationMethod;
}

export interface TaxFormData {
  // Always shown
  taxYear: number;
  entityType: EntityType;
  filingStatus: FilingStatus;
  isSoleOwner: boolean;
  isFranchise: boolean;
  isRetail: boolean;
  isMultiState: boolean;

  // Income
  totalRevenue: number;
  cogs: number;
  beginningInventory?: number;
  endingInventory?: number;

  // Operating expenses
  totalOperatingExpenses: number;
  rentLeasePayments: number;
  utilities?: number;
  businessInsurancePremiums: number;
  professionalFees?: number;
  marketingAdvertising?: number;
  officeSupplies?: number;
  bankFees?: number;
  softwareSubscriptions?: number;

  // Payroll
  hasEmployees: boolean;
  employeeCount?: number;
  totalEmployeeWages?: number;
  employerPayrollTaxes?: number;
  retirementPlanContributions?: number;
  employerHealthInsurance?: number;

  // Contractors
  hasContractors: boolean;
  total1099Payments?: number;

  // Vehicle
  hasBusinessVehicle: boolean;
  vehicleMethod?: VehicleMethod;
  vehicleMilesDriven?: number;
  actualVehicleExpenses?: number;
  businessUsePercent?: number;

  // Home office
  hasHomeOffice: boolean;
  homeOfficeMethod?: HomeOfficeMethod;
  homeOfficeSqFt?: number;
  totalHomeSqFt?: number;
  homeOfficeActualExpenses?: number;

  // Equipment
  hasEquipment: boolean;
  fixedAssets?: FixedAsset[];
  totalEquipmentCost?: number;

  // Franchise
  royaltyFees?: number;
  adFundContributions?: number;
  initialFranchiseFeePaidThisYear?: number;

  // Loans
  hasBusinessLoans: boolean;
  loanInterestPaid?: number;
  loanPrincipalPaid?: number;

  // Sales tax
  salesTaxCollected?: number;
  salesTaxRemitted?: number;

  // Owner
  ownershipPercent: number;
  ownerHealthInsurancePremiums: number;
  ownerCompensation?: number;
  ownerDistributions?: number;

  // Multi-state
  outOfStateRevenuePercent?: number;

  // Calculation preferences
  useStandards: boolean;
}

export interface BedrockTaxResponse {
  estimatedFederalTaxableIncome: number;
  estimatedFederalTaxLiability: number;
  estimatedSelfEmploymentTax: number;
  estimatedTexasFranchiseTax: number;
  texasMarginMethodUsed: string;
  texasMarginMethodComparison: Array<{ method: string; margin: number; tax: number }>;
  estimatedSalesTaxOwed: number;
  qbiDeduction: number;
  estimatedQuarterlyPayments: Array<{ quarter: string; dueDate: string; amount: number }>;
  keyDeductions: string[];
  taxSavingOpportunities: string[];
  flaggedForCPAReview: string[];
  formsToFile: string[];
  yearOverYearChanges: string[];
  ownerSummary: string;
  disclaimer: string;
}

export interface TaxSession {
  sessionId: string;
  taxYear: number;
  entityType: string;
  createdAt: string;
  status: 'pending' | 'complete' | 'error';
  inputData?: TaxFormData;
  result?: BedrockTaxResponse;
}

export interface Credential {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

// Document upload types
export type DocType =
  | 'auto'
  | 'profit-loss'
  | 'bank-statement'
  | 'line-of-credit'
  | 'payroll-summary'
  | 'royalty-statement'
  | 'sales-tax-return'
  | 'fixed-assets'
  | 'insurance'
  | 'lease'
  | 'general';

export interface UploadedDocument {
  objectKey: string;
  fileName: string;
  docType: DocType;
  uploadedAt: string;
  extracted?: Record<string, unknown>;
}

/**
 * Result from extracting a bank or line-of-credit statement.
 * The model classifies every transaction into a tax category,
 * then returns per-category totals plus the flagged items that need review.
 */
export interface BankStatementExtraction {
  statementType: 'business-checking' | 'line-of-credit' | 'unknown';
  bankName?: string;
  accountLast4?: string;
  periodStart?: string;
  periodEnd?: string;

  /** Per-category totals — keys MUST match TaxFormData field names */
  categoryTotals: Partial<Record<keyof CategoryTotals, number>>;

  /** Transactions the model couldn't confidently categorize */
  flaggedTransactions: Array<{
    date: string;
    description: string;
    amount: number;
    reason: string;
  }>;

  /** Total deposits / inflows (sales, transfers in, etc.) */
  totalDeposits?: number;

  /** Total withdrawals / outflows */
  totalWithdrawals?: number;

  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

/** Tax-form fields a bank statement can populate. Mirrors keys in TaxFormData. */
export type CategoryTotals = {
  rentLeasePayments: number;
  utilities: number;
  businessInsurancePremiums: number;
  professionalFees: number;
  marketingAdvertising: number;
  officeSupplies: number;
  bankFees: number;
  softwareSubscriptions: number;
  royaltyFees: number;
  adFundContributions: number;
  loanInterestPaid: number;
  loanPrincipalPaid: number;
  totalEmployeeWages: number;
  employerHealthInsurance: number;
  total1099Payments: number;
  totalEquipmentCost: number;
  ownerHealthInsurancePremiums: number;
};

/** Persistent record of an uploaded document, returned by GET /documents */
export interface PersistedDocument {
  docId: string;
  fileName: string;
  docType: DocType;
  objectKey: string;
  contentType: string;
  uploadedAt: string;
  appliedTotals: Partial<CategoryTotals>;
  flagged: Array<{
    date: string;
    description: string;
    amount: number;
    reason: string;
    /** AI's best guess at which tax-form field this transaction belongs to.
     *  Used to pre-select the dropdown when the user clicks Categorize.
     *  Null if the AI has no guess. */
    bestGuessField?: string | null;
    /** AI's confidence in the bestGuessField suggestion. */
    guessConfidence?: 'high' | 'medium' | 'low' | null;
    /** Set after the user explicitly resolves the flagged item. */
    resolution?: {
      action: 'apply' | 'ignore';
      /** Tax form field — present when action === 'apply' */
      field?: keyof CategoryTotals | string;
      /** Amount actually applied (defaults to abs(amount), but user can edit) */
      appliedAmount?: number;
      resolvedAt: string;
    };
  }>;
  bankName?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  notes?: string | null;
  autoClassified?: boolean;
  autoClassifyResult?: {
    classifiedAs: string;
    confidence: 'high' | 'medium' | 'low';
    rationale: string;
    bestGuessLabel?: string;
  } | null;
}

/** Audit trail entry shown in the imports panel after each upload */
export interface ImportAuditEntry {
  id: string;
  fileName: string;
  docType: DocType;
  uploadedAt: string;
  appliedTotals: Partial<CategoryTotals>;
  flagged: Array<{
    date: string;
    description: string;
    amount: number;
    reason: string;
  }>;
  bankName?: string;
  periodStart?: string;
  periodEnd?: string;
}
