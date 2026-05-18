/**
 * Shared types between Lambda and frontend.
 * Mirror this in src/types/index.ts when changes are made.
 */

export type EntityType =
  | 'LLC' // Single-member LLC (default for sole owner)
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
  placedInServiceDate: string; // ISO date
  method: DepreciationMethod;
}

export interface TaxFormData {
  // ── Section 1: Always shown ──────────────────────────────────────
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
  businessInsurancePremiums: number; // general liability, property, workers comp, etc.
  professionalFees?: number; // legal, CPA, consulting
  marketingAdvertising?: number;
  officeSupplies?: number;
  bankFees?: number;
  softwareSubscriptions?: number;

  // ── Section 2: Payroll (if hasEmployees) ─────────────────────────
  hasEmployees: boolean;
  employeeCount?: number;
  totalEmployeeWages?: number;
  employerPayrollTaxes?: number; // FICA + FUTA + SUTA matching
  retirementPlanContributions?: number;
  employerHealthInsurance?: number;

  // ── Section 3: Contractors (if hasContractors) ───────────────────
  hasContractors: boolean;
  total1099Payments?: number;

  // ── Section 4: Vehicle (if hasBusinessVehicle) ───────────────────
  hasBusinessVehicle: boolean;
  vehicleMethod?: VehicleMethod;
  vehicleMilesDriven?: number;
  actualVehicleExpenses?: number; // gas, maintenance, insurance, lease/depreciation
  businessUsePercent?: number;

  // ── Section 5: Home office (if hasHomeOffice) ────────────────────
  hasHomeOffice: boolean;
  homeOfficeMethod?: HomeOfficeMethod;
  homeOfficeSqFt?: number;
  totalHomeSqFt?: number;
  homeOfficeActualExpenses?: number; // utilities, mortgage interest, etc.

  // ── Section 6: Equipment / depreciation (if hasEquipment) ────────
  hasEquipment: boolean;
  fixedAssets?: FixedAsset[];
  totalEquipmentCost?: number; // simplified — sum of all equipment

  // ── Section 7: Franchise (if isFranchise) ────────────────────────
  royaltyFees?: number;
  adFundContributions?: number;
  initialFranchiseFeePaidThisYear?: number;

  // ── Section 8: Loans (if hasBusinessLoans) ───────────────────────
  hasBusinessLoans: boolean;
  loanInterestPaid?: number;
  loanPrincipalPaid?: number;

  // ── Section 9: Sales tax (if isRetail) ───────────────────────────
  salesTaxCollected?: number;
  salesTaxRemitted?: number;

  // ── Section 10: Owner / pass-through specifics ───────────────────
  ownershipPercent: number; // 100 for sole owner
  ownerHealthInsurancePremiums: number;
  ownerCompensation?: number; // S-Corp W-2 wages to owner
  ownerDistributions?: number; // S-Corp distributions / partner draws

  // ── Section 11: Multi-state (if isMultiState) ────────────────────
  outOfStateRevenuePercent?: number;

  // ── Section 12: Calculation preferences ──────────────────────────
  useStandards: boolean;
}

export interface BedrockTaxResponse {
  estimatedFederalTaxableIncome: number;
  estimatedFederalTaxLiability: number;
  estimatedSelfEmploymentTax: number;
  estimatedTexasFranchiseTax: number;
  texasMarginMethodUsed: string;
  texasMarginMethodComparison: Array<{
    method: string;
    margin: number;
    tax: number;
  }>;
  estimatedSalesTaxOwed: number;
  qbiDeduction: number;
  estimatedQuarterlyPayments: Array<{
    quarter: string;
    dueDate: string;
    amount: number;
  }>;
  keyDeductions: string[];
  taxSavingOpportunities: string[];
  flaggedForCPAReview: string[];
  formsToFile: string[];
  yearOverYearChanges: string[];
  ownerSummary: string;
  disclaimer: string;
}
