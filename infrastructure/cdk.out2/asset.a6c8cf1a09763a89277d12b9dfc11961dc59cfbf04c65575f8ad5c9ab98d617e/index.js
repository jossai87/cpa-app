"use strict";var O=Object.create;var T=Object.defineProperty;var _=Object.getOwnPropertyDescriptor;var B=Object.getOwnPropertyNames;var M=Object.getPrototypeOf,L=Object.prototype.hasOwnProperty;var N=(e,t)=>{for(var n in t)T(e,n,{get:t[n],enumerable:!0})},C=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let i of B(t))!L.call(e,i)&&i!==n&&T(e,i,{get:()=>t[i],enumerable:!(r=_(t,i))||r.enumerable});return e};var w=(e,t,n)=>(n=e!=null?O(M(e)):{},C(t||!e||!e.__esModule?T(n,"default",{value:e,enumerable:!0}):n,e)),k=e=>C(T({},"__esModule",{value:!0}),e);var j={};N(j,{handler:()=>K});module.exports=k(j);var b=require("@aws-sdk/client-bedrock-runtime"),D=require("@aws-sdk/client-dynamodb"),m=require("@aws-sdk/lib-dynamodb");var R=w(require("crypto")),$=new Uint8Array(256),S=$.length;function v(){return S>$.length-16&&(R.default.randomFillSync($),S=0),$.slice(S,S+=16)}var l=[];for(let e=0;e<256;++e)l.push((e+256).toString(16).slice(1));function E(e,t=0){return l[e[t+0]]+l[e[t+1]]+l[e[t+2]]+l[e[t+3]]+"-"+l[e[t+4]]+l[e[t+5]]+"-"+l[e[t+6]]+l[e[t+7]]+"-"+l[e[t+8]]+l[e[t+9]]+"-"+l[e[t+10]]+l[e[t+11]]+l[e[t+12]]+l[e[t+13]]+l[e[t+14]]+l[e[t+15]]}var I=w(require("crypto")),P={randomUUID:I.default.randomUUID};function q(e,t,n){if(P.randomUUID&&!t&&!e)return P.randomUUID();e=e||{};let r=e.random||(e.rng||v)();if(r[6]=r[6]&15|64,r[8]=r[8]&63|128,t){n=n||0;for(let i=0;i<16;++i)t[n+i]=r[i];return t}return E(r)}var F=q;var Y=new Set(["ssn","ein","password"]);function y(e){return e==null||typeof e!="object"?e:Array.isArray(e)?e.map(n=>y(n)):Object.fromEntries(Object.entries(e).map(([n,r])=>Y.has(n.toLowerCase())?[n,"[REDACTED]"]:[n,y(r)]))}var s={standardMileageRate:.725,section179:{maxDeduction:256e4,phaseOutStart:409e4,phaseOutEnd:665e4,maxSuvDeduction:30500},bonusDepreciation:{rate:1,permanent:!0},qbi:{rate:.23,permanent:!0,thresholds:{single:{start:201750,end:251750},marriedFilingJointly:{start:403500,end:503500}}},selfEmploymentTax:{socialSecurityRate:.124,medicareRate:.029,additionalMedicareRate:.009,socialSecurityWageBase2026:176100,additionalMedicareThreshold:{single:2e5,marriedFilingJointly:25e4},deductibleSelfEmploymentRate:.5},homeOffice:{simplifiedRatePerSqFt:5,simplifiedMaxSqFt:300,simplifiedMaxDeduction:1500},section197AmortizationYears:15,retirement:{sepIra:{maxContribution:7e4,percentOfCompensation:.25},solo401kEmployee:23500,solo401kCatchUp50Plus:7500,solo401kEmployer:.25,solo401kTotalCap:7e4,simpleIra:{maxContribution:16500,catchUp50Plus:3500}},brackets2026Single:[{upTo:11925,rate:.1},{upTo:48475,rate:.12},{upTo:103350,rate:.22},{upTo:197300,rate:.24},{upTo:250525,rate:.32},{upTo:626350,rate:.35},{upTo:1/0,rate:.37}],brackets2026Mfj:[{upTo:23850,rate:.1},{upTo:96950,rate:.12},{upTo:206700,rate:.22},{upTo:394600,rate:.24},{upTo:501050,rate:.32},{upTo:751600,rate:.35},{upTo:1/0,rate:.37}],standardDeduction:{single:16100,marriedFilingJointly:32200,headOfHousehold:24150},estimatedTaxDueDates2026:["April 15, 2026","June 15, 2026","September 15, 2026","January 15, 2027"]},u={salesTax:{state:.0625,cityOfDenton:.015,dctaTransit:.005,combined:.0825},franchiseTax:{noTaxDueThreshold:265e4,rateRetailWholesale:.00375,rateOther:.0075,compensationDeductionCap:48e4,ezComputation:{revenueThreshold:2e7,rate:.00331},annualReportDueDate:"May 15",extendedReportDueDate:"August 15",secondExtensionDueDate:"November 15",marginMethods:[{id:"revenue_minus_cogs",label:"Total Revenue minus Cost of Goods Sold"},{id:"revenue_minus_compensation",label:"Total Revenue minus Compensation"},{id:"70_percent_revenue",label:"70% of Total Revenue"},{id:"revenue_minus_1m",label:"Total Revenue minus $1 million"}]},hasStateIncomeTax:!1},c={naicsCode:"448210",expenseRatios:{cogsPercent:{low:.45,typical:.55,high:.65},rentPercent:{low:.05,typical:.08,high:.12},payrollPercent:{low:.1,typical:.18,high:.25},advertisingPercent:{low:.01,typical:.03,high:.06},insurancePercent:{low:.005,typical:.015,high:.03}},reasonableCompFullTime:{low:45e3,median:65e3,high:95e3}},p={naicsCode:"448210",royaltyPercent:.05,typicalAdFundPercent:.02,classificationForFranchiseTax:"retail",initialFranchiseFeeAmortizationYears:15};var J=new D.DynamoDBClient({region:"us-east-1"}),h=m.DynamoDBDocumentClient.from(J),U=new b.BedrockRuntimeClient({region:"us-east-1"}),x=process.env.TABLE_NAME,W=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}function o(e){return e==null?"not provided":`$${e.toLocaleString()}`}function G(e){return`You are an expert CPA tax assistant analyzing a small business tax return for tax year ${e.taxYear}. Your analysis must be accurate, compliant with current 2026 IRS and Texas tax law, and tailored to a Foot Solutions retail franchise location in Denton County, Texas.

## Business Profile
- Entity Type: ${e.entityType}
- Filing Status: ${e.filingStatus}
- Industry: Specialty retail footwear and orthotics (NAICS ${p.naicsCode})
- Location: Denton County, Texas
- Sole Owner: ${e.isSoleOwner?"Yes":"No"}
- Franchise: ${e.isFranchise?"Yes (Foot Solutions)":"No"}
- Retail Classification: ${e.isRetail?"Yes \u2014 qualifies for Texas reduced franchise tax rate":"No"}
- Multi-state operations: ${e.isMultiState?"Yes":"No"}

## Income & Cost of Goods Sold
- Total Annual Revenue: ${o(e.totalRevenue)}
- Cost of Goods Sold: ${o(e.cogs)}
- Beginning Inventory: ${o(e.beginningInventory)}
- Ending Inventory: ${o(e.endingInventory)}

## Operating Expenses
- Total Operating Expenses: ${o(e.totalOperatingExpenses)}
- Rent / Lease: ${o(e.rentLeasePayments)}
- Utilities: ${o(e.utilities)}
- Business Insurance Premiums: ${o(e.businessInsurancePremiums)}
- Professional Fees (legal/CPA): ${o(e.professionalFees)}
- Marketing/Advertising: ${o(e.marketingAdvertising)}
- Office Supplies: ${o(e.officeSupplies)}
- Bank/Merchant Fees: ${o(e.bankFees)}
- Software Subscriptions: ${o(e.softwareSubscriptions)}

## Payroll
${e.hasEmployees?`- Number of Employees: ${e.employeeCount??0}
- Total Employee Wages (W-2): ${o(e.totalEmployeeWages)}
- Employer Payroll Taxes (FICA + FUTA + SUTA): ${o(e.employerPayrollTaxes)}
- Retirement Plan Contributions (employer match): ${o(e.retirementPlanContributions)}
- Employer-Paid Employee Health Insurance: ${o(e.employerHealthInsurance)}`:"- No W-2 employees"}

## Contractors
${e.hasContractors?`- Total 1099-NEC Payments: ${o(e.total1099Payments)}`:"- No 1099 contractors"}

## Business Vehicle
${e.hasBusinessVehicle?`- Method: ${e.vehicleMethod==="standard_mileage"?"Standard Mileage Rate":"Actual Expenses"}
- Business Miles Driven: ${(e.vehicleMilesDriven??0).toLocaleString()}
- Business Use Percent: ${e.businessUsePercent??100}%
- Standard Mileage Deduction (calculated): ${o((e.vehicleMilesDriven??0)*s.standardMileageRate)}
${e.vehicleMethod==="actual_expenses"?`- Actual Vehicle Expenses: ${o(e.actualVehicleExpenses)}`:""}`:"- No business vehicle"}

## Home Office
${e.hasHomeOffice?`- Method: ${e.homeOfficeMethod==="simplified"?"Simplified ($5/sqft)":"Actual Expenses"}
- Home Office Square Footage: ${e.homeOfficeSqFt??0}
- Total Home Square Footage: ${e.totalHomeSqFt??0}
${e.homeOfficeMethod==="simplified"?`- Simplified Deduction (calculated): ${o(Math.min(e.homeOfficeSqFt??0,s.homeOffice.simplifiedMaxSqFt)*s.homeOffice.simplifiedRatePerSqFt)}`:`- Actual Home Office Expenses: ${o(e.homeOfficeActualExpenses)}`}`:"- No home office"}

## Equipment & Depreciation
${e.hasEquipment?`- Total Equipment Cost This Year: ${o(e.totalEquipmentCost)}
- Section 179 Limit (2026): ${o(s.section179.maxDeduction)}
- Phase-out begins at: ${o(s.section179.phaseOutStart)}
- Bonus Depreciation: 100% permanent (OBBBA)
${e.fixedAssets&&e.fixedAssets.length>0?`- Asset detail:
${e.fixedAssets.map(t=>`  \u2022 ${t.description}: ${o(t.cost)}, placed in service ${t.placedInServiceDate}, method: ${t.method}`).join(`
`)}`:""}`:"- No equipment purchases this year"}

## Franchise (Foot Solutions)
${e.isFranchise?`- Royalty Rate (per FDD): ${(p.royaltyPercent*100).toFixed(0)}% of gross sales \u2014 expected royalty for revenue of ${o(e.totalRevenue)} is ${o(e.totalRevenue*p.royaltyPercent)}
- Royalty Fees Paid: ${o(e.royaltyFees)}
- Advertising Fund Contributions: ${o(e.adFundContributions)}
- Initial Franchise Fee Paid This Year: ${o(e.initialFranchiseFeePaidThisYear)} (amortize over ${p.initialFranchiseFeeAmortizationYears} years per Section 197)
- IF the user-reported royaltyFees deviates more than 10% from the expected ${(p.royaltyPercent*100).toFixed(0)}% \xD7 revenue, flag it under "flaggedForCPAReview" with the discrepancy.`:""}

## Business Loans
${e.hasBusinessLoans?`- Loan Interest Paid (deductible): ${o(e.loanInterestPaid)}
- Loan Principal Paid (NOT deductible): ${o(e.loanPrincipalPaid)}`:"- No business loans"}

## Sales Tax (Texas Retail)
${e.isRetail?`- Sales Tax Collected: ${o(e.salesTaxCollected)}
- Sales Tax Remitted: ${o(e.salesTaxRemitted)}
- Combined Denton Rate: ${(u.salesTax.combined*100).toFixed(2)}% (TX ${(u.salesTax.state*100).toFixed(2)}% + Denton ${(u.salesTax.cityOfDenton*100).toFixed(2)}% + DCTA ${(u.salesTax.dctaTransit*100).toFixed(2)}%)`:""}

## Owner / Pass-Through Specifics
- Ownership Percent: ${e.ownershipPercent}%
- Owner Health Insurance Premiums: ${o(e.ownerHealthInsurancePremiums)}
${e.entityType==="S-Corp"?`- Owner W-2 Compensation (S-Corp): ${o(e.ownerCompensation)}`:""}
${e.entityType==="S-Corp"||e.entityType==="Multi-Member LLC"||e.entityType==="Partnership"?`- Owner Distributions/Draws: ${o(e.ownerDistributions)}`:""}

${e.isMultiState&&e.outOfStateRevenuePercent?`## Multi-State Apportionment
- Out-of-state Revenue Percent: ${e.outOfStateRevenuePercent}%`:""}

## Standards Toggle
- Apply Standard Rates Automatically: ${e.useStandards?"YES \u2014 use the constants below":"NO \u2014 use only what the user provided"}

## CRITICAL 2026 TAX CONSTANTS (USE THESE EXACT VALUES)
### Federal (2026 \u2014 IRS Notice 2026-10 + OBBBA)
- IRS Standard Mileage Rate: $${s.standardMileageRate}/mile
- Section 179 max deduction: ${o(s.section179.maxDeduction)} (phase-out at ${o(s.section179.phaseOutStart)})
- Bonus depreciation: 100% PERMANENT (OBBBA \u2014 applies to property placed in service after Jan 19, 2025)
- Section 199A QBI deduction: ${(s.qbi.rate*100).toFixed(0)}% (RAISED from 20% by OBBBA \u2014 now permanent)
- QBI thresholds (single): $${s.qbi.thresholds.single.start.toLocaleString()}\u2013$${s.qbi.thresholds.single.end.toLocaleString()}
- QBI thresholds (MFJ): $${s.qbi.thresholds.marriedFilingJointly.start.toLocaleString()}\u2013$${s.qbi.thresholds.marriedFilingJointly.end.toLocaleString()}
- Self-employment tax: 12.4% SS (up to $${s.selfEmploymentTax.socialSecurityWageBase2026.toLocaleString()}) + 2.9% Medicare on all
- Additional Medicare 0.9% above $200K (single) / $250K (MFJ)
- Standard deduction: single $${s.standardDeduction.single.toLocaleString()}, MFJ $${s.standardDeduction.marriedFilingJointly.toLocaleString()}
- Section 197 (franchise fee amortization): 15 years
- Solo 401(k) employee max: $${s.retirement.solo401kEmployee.toLocaleString()} (under 50)
- SEP-IRA: lesser of 25% of compensation or $${s.retirement.sepIra.maxContribution.toLocaleString()}

### Texas (2026/2027 \u2014 TX Comptroller)
- Franchise tax no-tax-due threshold: ${o(u.franchiseTax.noTaxDueThreshold)}
- Retail/wholesale rate: ${(u.franchiseTax.rateRetailWholesale*100).toFixed(3)}%
- All other rate: ${(u.franchiseTax.rateOther*100).toFixed(2)}%
- Compensation deduction cap per employee: ${o(u.franchiseTax.compensationDeductionCap)}
- EZ Computation: ${(u.franchiseTax.ezComputation.rate*100).toFixed(3)}% on revenue if total revenue \u2264 ${o(u.franchiseTax.ezComputation.revenueThreshold)}
- Four margin methods: (1) revenue minus COGS, (2) revenue minus compensation (capped at $${u.franchiseTax.compensationDeductionCap.toLocaleString()}/employee), (3) 70% of revenue, (4) revenue minus $1M
- Franchise tax annual report due: ${u.franchiseTax.annualReportDueDate}
- No state income tax for individuals or businesses
- Combined Denton sales tax rate: ${(u.salesTax.combined*100).toFixed(2)}%

### Industry Benchmarks (NAICS ${c.naicsCode} \u2014 specialty footwear retail)
- Typical COGS: ${(c.expenseRatios.cogsPercent.typical*100).toFixed(0)}% of revenue (range ${(c.expenseRatios.cogsPercent.low*100).toFixed(0)}\u2013${(c.expenseRatios.cogsPercent.high*100).toFixed(0)}%)
- Typical rent: ${(c.expenseRatios.rentPercent.typical*100).toFixed(0)}% of revenue
- Typical payroll: ${(c.expenseRatios.payrollPercent.typical*100).toFixed(0)}% of revenue
- Reasonable comp range for full-time owner-operator S-Corp: $${c.reasonableCompFullTime.low.toLocaleString()}\u2013$${c.reasonableCompFullTime.high.toLocaleString()}/year (median $${c.reasonableCompFullTime.median.toLocaleString()})

## Required Output Format
Return ONLY a valid JSON object with this exact structure (no markdown fences, no surrounding text):

{
  "estimatedFederalTaxableIncome": <number>,
  "estimatedFederalTaxLiability": <number>,
  "estimatedSelfEmploymentTax": <number>,
  "estimatedTexasFranchiseTax": <number>,
  "texasMarginMethodUsed": "<one of: revenue_minus_cogs | revenue_minus_compensation | 70_percent_revenue | revenue_minus_1m | ez_computation | no_tax_due>",
  "texasMarginMethodComparison": [
    {"method": "revenue_minus_cogs", "margin": <number>, "tax": <number>},
    {"method": "revenue_minus_compensation", "margin": <number>, "tax": <number>},
    {"method": "70_percent_revenue", "margin": <number>, "tax": <number>},
    {"method": "revenue_minus_1m", "margin": <number>, "tax": <number>}
  ],
  "estimatedSalesTaxOwed": <number>,
  "qbiDeduction": <number>,
  "estimatedQuarterlyPayments": [
    {"quarter": "Q1 2026", "dueDate": "April 15, 2026", "amount": <number>},
    {"quarter": "Q2 2026", "dueDate": "June 15, 2026", "amount": <number>},
    {"quarter": "Q3 2026", "dueDate": "September 15, 2026", "amount": <number>},
    {"quarter": "Q4 2026", "dueDate": "January 15, 2027", "amount": <number>}
  ],
  "keyDeductions": [
    "<deduction with $ amount>",
    "..."
  ],
  "taxSavingOpportunities": [
    "<specific actionable suggestion>",
    "..."
  ],
  "flaggedForCPAReview": [
    "<item that needs CPA attention>",
    "..."
  ],
  "formsToFile": [
    "<IRS or TX form number with brief description>",
    "..."
  ],
  "yearOverYearChanges": [
    "<note about 2026 changes vs 2025: OBBBA QBI 20%\u219223%, Section 179 doubled, mileage 70\xA2\u219272.5\xA2, TX no-tax-due $2.47M\u2192$2.65M, etc.>"
  ],
  "ownerSummary": "<2-4 sentence plain-English summary the owner can read at a glance>",
  "disclaimer": "This is a Bedrock-generated estimate using current 2026 tax law (OBBBA + IRS Notice 2026-10 + TX Comptroller 2026/2027 schedule). Final tax liability requires CPA review and may vary based on items not captured in this form."
}

## Analysis Instructions
1. **Calculate Texas franchise tax** using ALL FOUR margin methods plus EZ Computation if applicable. Show the comparison and use the LOWEST tax. If revenue is below $${u.franchiseTax.noTaxDueThreshold.toLocaleString()}, the tax is $0 but a Public Information Report is still required.
2. **Calculate sales tax owed** as collected minus remitted (if both provided), or estimate as ${(u.salesTax.combined*100).toFixed(2)}% \xD7 revenue if only revenue is known.
3. **Calculate federal taxable income** as revenue minus COGS minus operating expenses minus depreciation/Section 179 minus QBI deduction.
4. **Apply 23% QBI deduction** for tax year 2026 (OBBBA). Apply phase-out if income exceeds thresholds.
5. **Calculate self-employment tax** for sole proprietorships and single-member LLCs using 15.3% on 92.35% of net earnings (capped at SS wage base).
6. **For S-Corps:** flag if owner W-2 compensation is below $${c.reasonableCompFullTime.low.toLocaleString()} (audit risk) and recommend the median ($${c.reasonableCompFullTime.median.toLocaleString()}). If owner takes large distributions but $0 W-2, flag as guaranteed audit risk.
7. **Quarterly payments:** total estimated annual liability \xF7 4, with adjustments if any current-year payments already made.
8. **Forms to file:** include the entity-specific federal forms (1040 Schedule C / 1120-S / 1065 / 8825), Form 4562 if any depreciation, Form 8995 or 8995-A for QBI, Schedule SE if self-employment tax, and TX 05-158/05-169/PIR for Texas.
9. **Year-over-year changes:** ALWAYS mention the OBBBA-driven changes (QBI 20%\u219223%, Section 179 doubled, bonus depreciation 100% permanent), the 2026 mileage rate increase to 72.5\xA2, and the TX no-tax-due threshold bump to $2.65M.
10. **Tax-saving opportunities:** suggest specific actions like retirement plan contributions (SEP-IRA up to 25% of compensation, Solo 401(k) up to $${s.retirement.solo401kEmployee.toLocaleString()} employee + 25% employer), accelerating equipment purchases for 100% bonus depreciation, S-Corp election for self-employment tax savings, etc.
11. **Audit risk flags:** compare expense ratios against retail footwear benchmarks. Flag if COGS/revenue is outside ${(c.expenseRatios.cogsPercent.low*100).toFixed(0)}\u2013${(c.expenseRatios.cogsPercent.high*100).toFixed(0)}% range, rent outside ${(c.expenseRatios.rentPercent.low*100).toFixed(0)}\u2013${(c.expenseRatios.rentPercent.high*100).toFixed(0)}%, or other ratios are unusually high/low.

Respond with ONLY the JSON object \u2014 no markdown, no commentary.`}async function V(e){let t={messages:[{role:"user",content:[{text:e}]}],inferenceConfig:{maxTokens:4096,temperature:.1}},n=new b.InvokeModelCommand({modelId:W,contentType:"application/json",accept:"application/json",body:JSON.stringify(t)}),r=await Promise.race([U.send(n),new Promise((d,g)=>setTimeout(()=>g(new Error("BEDROCK_TIMEOUT")),29e3))]),A=JSON.parse(new TextDecoder().decode(r.body)).output.message.content[0].text.replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();return JSON.parse(A)}async function z(e,t){if(!e.body)return a(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!n.taxYear||n.taxYear<2e3||n.taxYear>2099)return a(400,{error:"taxYear must be between 2000 and 2099",field:"taxYear"});if(n.totalRevenue===void 0||n.totalRevenue<0)return a(400,{error:"totalRevenue is required and must be non-negative",field:"totalRevenue"});if(n.cogs===void 0||n.cogs<0)return a(400,{error:"cogs is required and must be non-negative",field:"cogs"});if(!n.entityType)return a(400,{error:"entityType is required",field:"entityType"});console.log("Tax calculation request:",JSON.stringify(y(n)));let r=F(),i=new Date().toISOString(),f;try{let d=G(n);f=await V(d)}catch(d){let g=d;return g.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock invocation timed out"),a(504,{error:"Tax analysis timed out. Please try again."})):(console.error("Bedrock invocation failed:",g.message),a(502,{error:"AI model returned an unexpected response. Please try again."}))}let A={userId:t,sk:`TAX#${r}`,sessionId:r,taxYear:n.taxYear,entityType:n.entityType,inputData:y(n),useStandards:n.useStandards,bedrockResponse:f,createdAt:i,status:"complete"};try{await h.send(new m.PutCommand({TableName:x,Item:A}))}catch(d){return console.error("DynamoDB write failed:",d.message),a(500,{error:"Failed to save tax session. Please try again."})}return a(200,{sessionId:r,taxYear:n.taxYear,createdAt:i,result:f})}async function X(e){try{let n=((await h.send(new m.QueryCommand({TableName:x,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"TAX#"},ScanIndexForward:!1,Limit:100,ProjectionExpression:"sessionId, taxYear, entityType, createdAt, #s",ExpressionAttributeNames:{"#s":"status"}}))).Items??[]).map(r=>({sessionId:r.sessionId,taxYear:r.taxYear,entityType:r.entityType,createdAt:r.createdAt,status:r.status}));return a(200,{sessions:n})}catch(t){return console.error("DynamoDB query failed:",t.message),a(500,{error:"Failed to retrieve tax history."})}}async function H(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Session ID is required"});try{let r=await h.send(new m.GetCommand({TableName:x,Key:{userId:t,sk:`TAX#${n}`}}));if(!r.Item)return a(404,{error:"Session not found"});let i=r.Item;return a(200,{sessionId:i.sessionId,taxYear:i.taxYear,entityType:i.entityType,createdAt:i.createdAt,status:i.status,useStandards:i.useStandards,inputData:i.inputData,result:i.bedrockResponse})}catch(r){return console.error("DynamoDB get failed:",r.message),a(500,{error:"Failed to retrieve tax session."})}}async function Q(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Session ID is required"});try{return(await h.send(new m.GetCommand({TableName:x,Key:{userId:t,sk:`TAX#${n}`}}))).Item?(await h.send(new m.DeleteCommand({TableName:x,Key:{userId:t,sk:`TAX#${n}`}})),a(200,{sessionId:n,deleted:!0})):a(404,{error:"Session not found"})}catch(r){return console.error("DynamoDB delete failed:",r.message),a(500,{error:"Failed to delete tax session."})}}var K=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /tax/calculate":return z(e,t);case"GET /tax/history":return X(t);case"GET /tax/history/{id}":return H(e,t);case"DELETE /tax/history/{id}":return Q(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
