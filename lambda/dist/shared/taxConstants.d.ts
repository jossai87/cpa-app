/**
 * 2026 Federal & Texas Tax Constants
 *
 * Single source of truth for all tax rates, thresholds, and limits.
 * Sourced from IRS Notice 2026-10, OBBBA (signed July 2025), and TX Comptroller.
 *
 * Update this file when new tax year guidance is published.
 */
export declare const TAX_YEAR = 2026;
export declare const FEDERAL: {
    standardMileageRate: number;
    section179: {
        maxDeduction: number;
        phaseOutStart: number;
        phaseOutEnd: number;
        maxSuvDeduction: number;
    };
    bonusDepreciation: {
        rate: number;
        permanent: boolean;
    };
    qbi: {
        rate: number;
        permanent: boolean;
        thresholds: {
            single: {
                start: number;
                end: number;
            };
            marriedFilingJointly: {
                start: number;
                end: number;
            };
        };
    };
    selfEmploymentTax: {
        socialSecurityRate: number;
        medicareRate: number;
        additionalMedicareRate: number;
        socialSecurityWageBase2026: number;
        additionalMedicareThreshold: {
            single: number;
            marriedFilingJointly: number;
        };
        deductibleSelfEmploymentRate: number;
    };
    homeOffice: {
        simplifiedRatePerSqFt: number;
        simplifiedMaxSqFt: number;
        simplifiedMaxDeduction: number;
    };
    section197AmortizationYears: number;
    retirement: {
        sepIra: {
            maxContribution: number;
            percentOfCompensation: number;
        };
        solo401kEmployee: number;
        solo401kCatchUp50Plus: number;
        solo401kEmployer: number;
        solo401kTotalCap: number;
        simpleIra: {
            maxContribution: number;
            catchUp50Plus: number;
        };
    };
    brackets2026Single: {
        upTo: number;
        rate: number;
    }[];
    brackets2026Mfj: {
        upTo: number;
        rate: number;
    }[];
    standardDeduction: {
        single: number;
        marriedFilingJointly: number;
        headOfHousehold: number;
    };
    estimatedTaxDueDates2026: string[];
};
export declare const TEXAS: {
    salesTax: {
        state: number;
        cityOfDenton: number;
        dctaTransit: number;
        combined: number;
    };
    franchiseTax: {
        noTaxDueThreshold: number;
        rateRetailWholesale: number;
        rateOther: number;
        compensationDeductionCap: number;
        ezComputation: {
            revenueThreshold: number;
            rate: number;
        };
        annualReportDueDate: string;
        extendedReportDueDate: string;
        secondExtensionDueDate: string;
        marginMethods: {
            id: string;
            label: string;
        }[];
    };
    hasStateIncomeTax: boolean;
};
export declare const RETAIL_FOOTWEAR_BENCHMARKS: {
    naicsCode: string;
    expenseRatios: {
        cogsPercent: {
            low: number;
            typical: number;
            high: number;
        };
        rentPercent: {
            low: number;
            typical: number;
            high: number;
        };
        payrollPercent: {
            low: number;
            typical: number;
            high: number;
        };
        advertisingPercent: {
            low: number;
            typical: number;
            high: number;
        };
        insurancePercent: {
            low: number;
            typical: number;
            high: number;
        };
    };
    reasonableCompFullTime: {
        low: number;
        median: number;
        high: number;
    };
};
export declare const FOOT_SOLUTIONS: {
    naicsCode: string;
    royaltyPercent: number;
    typicalAdFundPercent: number;
    classificationForFranchiseTax: string;
    initialFranchiseFeeAmortizationYears: number;
};
//# sourceMappingURL=taxConstants.d.ts.map