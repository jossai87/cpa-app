"use strict";var F=Object.create;var y=Object.defineProperty;var j=Object.getOwnPropertyDescriptor;var R=Object.getOwnPropertyNames;var L=Object.getPrototypeOf,U=Object.prototype.hasOwnProperty;var Y=(e,t)=>{for(var n in t)y(e,n,{get:t[n],enumerable:!0})},S=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of R(t))!U.call(e,o)&&o!==n&&y(e,o,{get:()=>t[o],enumerable:!(r=j(t,o))||r.enumerable});return e};var T=(e,t,n)=>(n=e!=null?F(L(e)):{},S(t||!e||!e.__esModule?y(n,"default",{value:e,enumerable:!0}):n,e)),B=e=>S(y({},"__esModule",{value:!0}),e);var X={};Y(X,{handler:()=>H});module.exports=B(X);var m=require("@aws-sdk/client-s3"),k=require("@aws-sdk/s3-request-presigner"),h=require("@aws-sdk/client-bedrock-runtime");var v=T(require("crypto")),g=new Uint8Array(256),f=g.length;function x(){return f>g.length-16&&(v.default.randomFillSync(g),f=0),g.slice(f,f+=16)}var a=[];for(let e=0;e<256;++e)a.push((e+256).toString(16).slice(1));function C(e,t=0){return a[e[t+0]]+a[e[t+1]]+a[e[t+2]]+a[e[t+3]]+"-"+a[e[t+4]]+a[e[t+5]]+"-"+a[e[t+6]]+a[e[t+7]]+"-"+a[e[t+8]]+a[e[t+9]]+"-"+a[e[t+10]]+a[e[t+11]]+a[e[t+12]]+a[e[t+13]]+a[e[t+14]]+a[e[t+15]]}var O=T(require("crypto")),b={randomUUID:O.default.randomUUID};function W(e,t,n){if(b.randomUUID&&!t&&!e)return b.randomUUID();e=e||{};let r=e.random||(e.rng||x)();if(r[6]=r[6]&15|64,r[8]=r[8]&63|128,t){n=n||0;for(let o=0;o<16;++o)t[n+o]=r[o];return t}return C(r)}var w=W;var E=new m.S3Client({region:"us-east-1"}),J=new h.BedrockRuntimeClient({region:"us-east-1"}),$=process.env.DOCS_BUCKET??"",K=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function s(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var q=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","image/png","image/jpeg"];function I(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var G=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","general"];async function M(e,t){if(!e.body)return s(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return s(400,{error:"Invalid JSON in request body"})}if(!n.fileName)return s(400,{error:"fileName is required"});let r=I(n.fileName),o=n.contentType&&n.contentType!==""?n.contentType:r;if(!q.includes(o))return s(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let l=G.includes(n.docType??"")?n.docType:"general",c=`${t}/${l}/${Date.now()}-${w()}-${n.fileName}`;try{let p=new m.PutObjectCommand({Bucket:$,Key:c}),u=await(0,k.getSignedUrl)(E,p,{expiresIn:300});return s(200,{uploadUrl:u,objectKey:c,docType:l,contentType:o,expiresIn:300})}catch(p){return console.error("Failed to create pre-signed URL:",p.message),s(500,{error:"Failed to create upload URL"})}}async function V(e,t){if(!e.body)return s(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return s(400,{error:"Invalid JSON in request body"})}if(!n.objectKey)return s(400,{error:"objectKey is required"});if(!n.objectKey.startsWith(`${t}/`))return s(403,{error:"Access denied to this document"});let r,o,l=null;try{let i=await E.send(new m.GetObjectCommand({Bucket:$,Key:n.objectKey}));if(o=i.ContentType??"application/octet-stream",o==="application/octet-stream"||o==="binary/octet-stream"){let d=I(n.objectKey);d!=="application/octet-stream"&&(o=d)}r=await i.Body.transformToByteArray(),(o==="text/csv"||o.startsWith("text/"))&&(l=new TextDecoder().decode(r),l.length>5e4&&(l=l.slice(0,5e4)+`

... [truncated]`))}catch(i){return console.error("Failed to read document from S3:",i.message),s(500,{error:"Failed to read uploaded document"})}let c=n.docType??"general",p=_(c,l),u=[];if(o==="application/pdf")u.push({document:{format:"pdf",name:"uploaded-document",source:{bytes:Buffer.from(r).toString("base64")}}});else if(o==="image/png"||o==="image/jpeg"||o==="image/jpg"){let i=o==="image/png"?"png":"jpeg";u.push({image:{format:i,source:{bytes:Buffer.from(r).toString("base64")}}})}else(o==="application/vnd.ms-excel"||o==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")&&u.push({document:{format:"xlsx",name:"uploaded-document",source:{bytes:Buffer.from(r).toString("base64")}}});u.push({text:p});let P;try{let d={messages:[{role:"user",content:u}],inferenceConfig:{maxTokens:c==="bank-statement"||c==="line-of-credit"?4096:2048,temperature:0}},D=new h.InvokeModelCommand({modelId:K,contentType:"application/json",accept:"application/json",body:JSON.stringify(d)}),N=await J.send(D),A=JSON.parse(new TextDecoder().decode(N.body)).output.message.content[0].text.replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();P=JSON.parse(A)}catch(i){return console.error("Extraction failed:",i.message),s(502,{error:"Failed to extract data from document"})}return s(200,{objectKey:n.objectKey,docType:c,contentType:o,extracted:P})}function _(e,t){if(e==="bank-statement"||e==="line-of-credit")return z(e,t);let n={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},r=n[e]??n.general,o=t?`
## Document Content (CSV)
\`\`\`
${t}
\`\`\``:"";return`You are extracting structured tax data from a ${e} document for a Foot Solutions retail franchise in Denton County, Texas.

${r}
${o}

## Output Format
Return ONLY a valid JSON object with the extracted fields. Use null for fields you cannot determine. All monetary values as plain numbers (no $ or commas, no cents). Example:

{
  "totalRevenue": 280000,
  "cogs": 200000,
  "businessInsurancePremiums": 4250,
  "rentLeasePayments": null,
  "extractedFromDocType": "${e}",
  "confidence": "high|medium|low",
  "notes": "<brief caveat or what was missing>"
}

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function z(e,t){let n=e==="line-of-credit",r=t?`
## Statement Content (CSV/text)
\`\`\`
${t}
\`\`\``:"";return`You are a CPA's automated bookkeeping assistant analyzing a ${n?"business line of credit":"business checking"} statement for a Foot Solutions retail franchise in Denton County, Texas.

Classify EVERY transaction in this statement and aggregate by tax category.

## Tax Categories (these MUST be the exact keys in the output)

| Key | What goes here |
|---|---|
| \`rentLeasePayments\` | Store rent, equipment leases, real estate lease |
| \`utilities\` | Electric, gas, water, internet, phone, garbage |
| \`businessInsurancePremiums\` | General liability, commercial property, workers comp, umbrella (NOT owner's personal health/life) |
| \`professionalFees\` | Legal, CPA, bookkeeping, business consulting |
| \`marketingAdvertising\` | Local ads, social media, Google Ads, signage, sponsorships, print (NOT franchisor ad fund) |
| \`officeSupplies\` | Pens, paper, packaging, small consumables |
| \`softwareSubscriptions\` | SaaS \u2014 POS subscription, QuickBooks, Microsoft 365, etc. |
| \`bankFees\` | Account fees, overdraft fees, wire fees, ACH fees |
| \`royaltyFees\` | Foot Solutions corporate royalty payments |
| \`adFundContributions\` | Foot Solutions national ad fund |
| \`loanInterestPaid\` | Interest portion of loan / line of credit payments |
| \`loanPrincipalPaid\` | Principal portion of loan / line of credit payments (informational, NOT deductible) |
| \`totalEmployeeWages\` | Direct deposit / payroll runs to employees |
| \`employerHealthInsurance\` | Health insurance premium payments for employees |
| \`total1099Payments\` | Payments to independent contractors |
| \`totalEquipmentCost\` | Major equipment purchases (foot scanners, 3D printers, POS hardware, furniture > $500) |
| \`ownerHealthInsurancePremiums\` | Owner's personal health insurance premiums |

## Classification Rules

1. **Skip transfers and owner draws** \u2014 internal transfers between accounts, owner withdrawals, and personal payments are NOT business expenses. Don't categorize them.
2. **Sales tax remittances** to the Texas Comptroller are NOT a business expense (they're collected from customers and passed through). Don't include.
3. **Sales tax collected from customers** (deposits) \u2014 track separately if visible, but don't categorize as expense.
4. **Credit card payments TO the credit card** (paying off the card balance) are NOT a separate expense \u2014 the underlying purchases are. Skip these.
5. **Foot Solutions Royalty** payments \u2192 \`royaltyFees\`. **Foot Solutions Ad Fund** \u2192 \`adFundContributions\`.
6. **Heartland / Global Payments processing fees** \u2192 \`bankFees\`.
7. **Property tax / DBA fees / state filings** \u2192 \`professionalFees\`.
8. **Anything truly ambiguous** \u2192 leave it out of categoryTotals and add it to flaggedTransactions with a one-line reason.

${n?`## Line of Credit Specifics

For each line of credit payment, the statement should show interest and principal separately. If only the total payment is shown, list it in flaggedTransactions so the user can split manually.

Origination fees, draw fees, annual fees on the LOC \u2192 \`bankFees\`.`:""}

## Output Format
Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "statementType": "${n?"line-of-credit":"business-checking"}",
  "bankName": "<name of bank, or null>",
  "accountLast4": "<last 4 digits of account, or null>",
  "periodStart": "<YYYY-MM-DD or null>",
  "periodEnd": "<YYYY-MM-DD or null>",
  "categoryTotals": {
    "rentLeasePayments": <sum or 0>,
    "utilities": <sum or 0>,
    "businessInsurancePremiums": <sum or 0>,
    "professionalFees": <sum or 0>,
    "marketingAdvertising": <sum or 0>,
    "officeSupplies": <sum or 0>,
    "softwareSubscriptions": <sum or 0>,
    "bankFees": <sum or 0>,
    "royaltyFees": <sum or 0>,
    "adFundContributions": <sum or 0>,
    "loanInterestPaid": <sum or 0>,
    "loanPrincipalPaid": <sum or 0>,
    "totalEmployeeWages": <sum or 0>,
    "employerHealthInsurance": <sum or 0>,
    "total1099Payments": <sum or 0>,
    "totalEquipmentCost": <sum or 0>,
    "ownerHealthInsurancePremiums": <sum or 0>
  },
  "flaggedTransactions": [
    {"date": "YYYY-MM-DD", "description": "<merchant>", "amount": <number>, "reason": "<short reason>"}
  ],
  "totalDeposits": <sum of all inflows or 0>,
  "totalWithdrawals": <sum of all outflows or 0>,
  "confidence": "high|medium|low",
  "notes": "<short caveat>"
}

All amounts MUST be plain positive numbers (no $, no commas, no cents \u2014 round to nearest dollar). Categories with $0 should be 0, not null. Set fields you cannot determine to null where allowed.

Respond with ONLY the JSON object.${r}`}var H=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return M(e,t);case"POST /documents/extract":return V(e,t);case"POST /documents/bda-job":return s(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});default:return s(404,{error:"Route not found"})}};0&&(module.exports={handler});
