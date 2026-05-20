/**
 * Shared types between Lambda and frontend.
 * Mirror this in src/types/index.ts when changes are made.
 */
export type EntityType = 'LLC' | 'S-Corp' | 'Sole Proprietorship' | 'Partnership' | 'Multi-Member LLC';
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
    taxYear: number;
    entityType: EntityType;
    filingStatus: FilingStatus;
    isSoleOwner: boolean;
    isFranchise: boolean;
    isRetail: boolean;
    isMultiState: boolean;
    totalRevenue: number;
    cogs: number;
    beginningInventory?: number;
    endingInventory?: number;
    totalOperatingExpenses: number;
    rentLeasePayments: number;
    utilities?: number;
    businessInsurancePremiums: number;
    professionalFees?: number;
    marketingAdvertising?: number;
    officeSupplies?: number;
    bankFees?: number;
    softwareSubscriptions?: number;
    hasEmployees: boolean;
    employeeCount?: number;
    totalEmployeeWages?: number;
    employerPayrollTaxes?: number;
    retirementPlanContributions?: number;
    employerHealthInsurance?: number;
    hasContractors: boolean;
    total1099Payments?: number;
    hasBusinessVehicle: boolean;
    vehicleMethod?: VehicleMethod;
    vehicleMilesDriven?: number;
    actualVehicleExpenses?: number;
    businessUsePercent?: number;
    hasHomeOffice: boolean;
    homeOfficeMethod?: HomeOfficeMethod;
    homeOfficeSqFt?: number;
    totalHomeSqFt?: number;
    homeOfficeActualExpenses?: number;
    hasEquipment: boolean;
    fixedAssets?: FixedAsset[];
    totalEquipmentCost?: number;
    royaltyFees?: number;
    adFundContributions?: number;
    initialFranchiseFeePaidThisYear?: number;
    hasBusinessLoans: boolean;
    loanInterestPaid?: number;
    loanPrincipalPaid?: number;
    salesTaxCollected?: number;
    salesTaxRemitted?: number;
    ownershipPercent: number;
    ownerHealthInsurancePremiums: number;
    ownerCompensation?: number;
    ownerDistributions?: number;
    outOfStateRevenuePercent?: number;
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
//# sourceMappingURL=types.d.ts.map