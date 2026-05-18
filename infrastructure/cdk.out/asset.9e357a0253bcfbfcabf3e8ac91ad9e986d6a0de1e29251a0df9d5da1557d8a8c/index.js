"use strict";var M=Object.create;var C=Object.defineProperty;var V=Object.getOwnPropertyDescriptor;var q=Object.getOwnPropertyNames;var J=Object.getPrototypeOf,_=Object.prototype.hasOwnProperty;var H=(e,t)=>{for(var n in t)C(e,n,{get:t[n],enumerable:!0})},$=(e,t,n,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of q(t))!_.call(e,r)&&r!==n&&C(e,r,{get:()=>t[r],enumerable:!(o=V(t,r))||o.enumerable});return e};var j=(e,t,n)=>(n=e!=null?M(J(e)):{},$(t||!e||!e.__esModule?C(n,"default",{value:e,enumerable:!0}):n,e)),z=e=>$(C({},"__esModule",{value:!0}),e);var me={};H(me,{handler:()=>de});module.exports=z(me);var f=require("@aws-sdk/client-s3"),L=require("@aws-sdk/s3-request-presigner"),A=require("@aws-sdk/client-bedrock-runtime"),U=require("@aws-sdk/client-dynamodb"),p=require("@aws-sdk/lib-dynamodb");var Y=j(require("crypto")),S=new Uint8Array(256),E=S.length;function F(){return E>S.length-16&&(Y.default.randomFillSync(S),E=0),S.slice(E,E+=16)}var l=[];for(let e=0;e<256;++e)l.push((e+256).toString(16).slice(1));function K(e,t=0){return l[e[t+0]]+l[e[t+1]]+l[e[t+2]]+l[e[t+3]]+"-"+l[e[t+4]]+l[e[t+5]]+"-"+l[e[t+6]]+l[e[t+7]]+"-"+l[e[t+8]]+l[e[t+9]]+"-"+l[e[t+10]]+l[e[t+11]]+l[e[t+12]]+l[e[t+13]]+l[e[t+14]]+l[e[t+15]]}var B=j(require("crypto")),O={randomUUID:B.default.randomUUID};function X(e,t,n){if(O.randomUUID&&!t&&!e)return O.randomUUID();e=e||{};let o=e.random||(e.rng||F)();if(o[6]=o[6]&15|64,o[8]=o[8]&63|128,t){n=n||0;for(let r=0;r<16;++r)t[n+r]=o[r];return t}return K(o)}var k=X;var D=new f.S3Client({region:"us-east-1"}),Q=new A.BedrockRuntimeClient({region:"us-east-1"}),Z=new U.DynamoDBClient({region:"us-east-1"}),w=p.DynamoDBDocumentClient.from(Z),N=process.env.DOCS_BUCKET??"",P=process.env.TABLE_NAME??"",ee=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var te=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function G(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var ne=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function oe(e,t){if(!e.body)return a(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!n.fileName)return a(400,{error:"fileName is required"});let o=G(n.fileName),r=n.contentType&&n.contentType!==""?n.contentType:o;if(!te.includes(r))return a(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let s=ne.includes(n.docType??"")?n.docType:"general",c=`${t}/${s}/${Date.now()}-${k()}-${n.fileName}`;try{let b=new f.PutObjectCommand({Bucket:N,Key:c}),d=await(0,L.getSignedUrl)(D,b,{expiresIn:300});return a(200,{uploadUrl:d,objectKey:c,docType:s,contentType:r,expiresIn:300})}catch(b){return console.error("Failed to create pre-signed URL:",b.message),a(500,{error:"Failed to create upload URL"})}}async function re(e,t){if(!e.body)return a(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!n.objectKey)return a(400,{error:"objectKey is required"});if(!n.objectKey.startsWith(`${t}/`))return a(403,{error:"Access denied to this document"});let o,r,s=null;try{let i=await D.send(new f.GetObjectCommand({Bucket:N,Key:n.objectKey}));if(r=i.ContentType??"application/octet-stream",r==="application/octet-stream"||r==="binary/octet-stream"){let u=G(n.objectKey);u!=="application/octet-stream"&&(r=u)}o=await i.Body.transformToByteArray(),(r==="text/csv"||r.startsWith("text/"))&&(s=new TextDecoder().decode(o),s.length>5e4&&(s=s.slice(0,5e4)+`

... [truncated]`))}catch(i){return console.error("Failed to read document from S3:",i.message),a(500,{error:"Failed to read uploaded document"})}function c(i){let u=[];if(r==="application/pdf")u.push({document:{format:"pdf",name:"uploaded-document",source:{bytes:Buffer.from(o).toString("base64")}}});else if(r==="image/png"||r==="image/jpeg"||r==="image/jpg"){let g=r==="image/png"?"png":"jpeg";u.push({image:{format:g,source:{bytes:Buffer.from(o).toString("base64")}}})}else r==="application/vnd.ms-excel"||r==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?u.push({document:{format:"xlsx",name:"uploaded-document",source:{bytes:Buffer.from(o).toString("base64")}}}):(r==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"||r==="application/msword")&&u.push({document:{format:"docx",name:"uploaded-document",source:{bytes:Buffer.from(o).toString("base64")}}});return u.push({text:i}),u}async function b(i,u){let g={messages:[{role:"user",content:i}],inferenceConfig:{maxTokens:u,temperature:0}},m=new A.InvokeModelCommand({modelId:ee,contentType:"application/json",accept:"application/json",body:JSON.stringify(g)}),x=await Q.send(m);return JSON.parse(new TextDecoder().decode(x.body)).output.message.content[0].text}let d=n.docType??"auto",T=null,h=null;if(d==="auto")try{let i=ae(s),g=(await b(c(i),4096)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),m=JSON.parse(g);T={classifiedAs:m.classifiedAs,confidence:m.classifyConfidence,rationale:m.classifyRationale,...m.bestGuessLabel&&{bestGuessLabel:m.bestGuessLabel}};let x=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];m.classifyConfidence==="low"||!x.includes(m.classifiedAs)?d="general":d=m.classifiedAs,h=m.extracted??{}}catch(i){console.warn("Auto classify+extract failed, falling back to general:",i.message),d="general",h=null}if(h===null){let i=se(d,s),u=c(i);try{let x=(await b(u,d==="bank-statement"||d==="line-of-credit"?4096:2048)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();h=JSON.parse(x)}catch(g){return console.error("Extraction failed:",g.message),a(502,{error:"Failed to extract data from document"})}}let I=k(),v=new Date().toISOString(),R=n.fileName||n.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document",y=h,W=d==="bank-statement"||d==="line-of-credit"?y.categoryTotals??{}:Object.fromEntries(Object.entries(y).filter(([,i])=>typeof i=="number"&&i>0));try{await w.send(new p.PutCommand({TableName:P,Item:{userId:t,sk:`DOC#${v}#${I}`,docId:I,objectKey:n.objectKey,fileName:R,docType:d,contentType:r,uploadedAt:v,appliedTotals:W,flagged:y.flaggedTransactions??[],bankName:y.bankName??null,periodStart:y.periodStart??null,periodEnd:y.periodEnd??null,confidence:y.confidence??null,notes:y.notes??null,autoClassified:T!==null,autoClassifyResult:T??null}}))}catch(i){console.error("Failed to persist document record:",i.message)}return a(200,{docId:I,objectKey:n.objectKey,fileName:R,docType:d,contentType:r,uploadedAt:v,extracted:h,autoClassifyResult:T})}function ae(e){return`You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

Step 1 \u2014 CLASSIFY the attached business document into ONE category:

- profit-loss          \u2192 P&L statement, income statement
- bank-statement       \u2192 business checking/savings monthly statement
- line-of-credit       \u2192 line of credit, business loan, or credit-card revolving statement
- payroll-summary      \u2192 payroll run, W-2 summary, 941 quarterly, payroll annual report
- royalty-statement    \u2192 Foot Solutions corporate royalty/ad fund report
- sales-tax-return     \u2192 Texas sales tax return / WebFile confirmation
- fixed-assets         \u2192 depreciation schedule, fixed asset register
- insurance            \u2192 commercial insurance policy/quote (general liability, workers comp, umbrella) \u2014 NOT health/life
- lease                \u2192 commercial lease agreement
- general              \u2192 none of the above

Step 2 \u2014 EXTRACT structured tax data based on the category you chose. The extraction rules per category:

**bank-statement / line-of-credit:** classify every transaction line and aggregate by tax category. Use this exact \`extracted\` shape:
{
  "statementType": "business-checking|line-of-credit|unknown",
  "bankName": "<or null>",
  "accountLast4": "<or null>",
  "periodStart": "<YYYY-MM-DD or null>",
  "periodEnd": "<YYYY-MM-DD or null>",
  "categoryTotals": {
    "rentLeasePayments": <num>, "utilities": <num>, "businessInsurancePremiums": <num>,
    "professionalFees": <num>, "marketingAdvertising": <num>, "officeSupplies": <num>,
    "softwareSubscriptions": <num>, "bankFees": <num>, "royaltyFees": <num>,
    "adFundContributions": <num>, "loanInterestPaid": <num>, "loanPrincipalPaid": <num>,
    "totalEmployeeWages": <num>, "employerHealthInsurance": <num>, "total1099Payments": <num>,
    "totalEquipmentCost": <num>, "ownerHealthInsurancePremiums": <num>
  },
  "flaggedTransactions": [{"date":"YYYY-MM-DD","description":"<>","amount":<n>,"reason":"<>"}],
  "totalDeposits": <num>, "totalWithdrawals": <num>,
  "confidence": "high|medium|low",
  "notes": "<short>"
}

Skip transfers, owner draws, sales tax remittances, and credit card payoff transactions. Foot Solutions Royalty \u2192 royaltyFees. Foot Solutions Ad Fund \u2192 adFundContributions. Heartland/Global Payments processing fees \u2192 bankFees.

**lease:** Extract \`rentLeasePayments\` (annual base rent \u2014 multiply monthly \xD7 12) and put lease term, dates, deposit, escalation in \`notes\`. Do NOT include security deposit in rentLeasePayments.

**insurance:** Extract \`businessInsurancePremiums\` (total annual premium \u2014 sum if multiple policies in one doc). Do NOT include owner health/life/disability.

**profit-loss:** Extract totalRevenue, cogs, totalOperatingExpenses, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.

**royalty-statement:** Extract totalRevenue (gross sales), royaltyFees, adFundContributions.

**sales-tax-return:** Extract totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.

**payroll-summary:** Extract totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.

**fixed-assets:** Extract totalEquipmentCost (sum of all assets).

**general:** Extract any obvious financial figures.

## Output Format
Return ONLY a JSON object, no markdown:

{
  "classifiedAs": "<one of the categories>",
  "classifyConfidence": "high|medium|low",
  "classifyRationale": "<one short sentence>",
  "bestGuessLabel": "<2-4 word label, e.g. 'Lease Agreement', 'Frost Bank Statement'>",
  "extracted": <the appropriate object for the category \u2014 see rules above>
}

All money values as plain numbers (no $, no commas, no cents).${e?`
## Document Content (CSV)
\`\`\`
${e}
\`\`\``:""}`}function se(e,t){if(e==="bank-statement"||e==="line-of-credit")return ie(e,t);let n={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',lease:"Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent \u2014 multiply monthly rent \xD7 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year "+new Date().getFullYear()+". Do NOT include the security deposit or one-time fees in rentLeasePayments.",general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},o=n[e]??n.general,r=t?`
## Document Content (CSV)
\`\`\`
${t}
\`\`\``:"";return`You are extracting structured tax data from a ${e} document for a Foot Solutions retail franchise in Denton County, Texas.

${o}
${r}

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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function ie(e,t){let n=e==="line-of-credit",o=t?`
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

Respond with ONLY the JSON object.${o}`}async function le(e){try{let n=((await w.send(new p.QueryCommand({TableName:P,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(o=>({docId:o.docId,fileName:o.fileName,docType:o.docType,objectKey:o.objectKey,contentType:o.contentType,uploadedAt:o.uploadedAt,appliedTotals:o.appliedTotals??{},flagged:o.flagged??[],bankName:o.bankName??null,periodStart:o.periodStart??null,periodEnd:o.periodEnd??null,confidence:o.confidence??null,notes:o.notes??null,autoClassified:o.autoClassified??!1,autoClassifyResult:o.autoClassifyResult??null}));return a(200,{documents:n})}catch(t){return console.error("Failed to list documents:",t.message),a(500,{error:"Failed to list documents"})}}async function ce(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Document id is required"});let o;try{o=(await w.send(new p.QueryCommand({TableName:P,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":n},Limit:1}))).Items?.[0]}catch(s){return console.error("Failed to look up document:",s.message),a(500,{error:"Failed to look up document"})}if(!o)return a(404,{error:"Document not found"});let r=o.objectKey;if(!r.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{let s=new f.GetObjectCommand({Bucket:N,Key:r}),c=await(0,L.getSignedUrl)(D,s,{expiresIn:300});return a(200,{downloadUrl:c,fileName:o.fileName,expiresIn:300})}catch(s){return console.error("Failed to create download URL:",s.message),a(500,{error:"Failed to create download URL"})}}async function ue(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Document id is required"});let o;try{o=(await w.send(new p.QueryCommand({TableName:P,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":n},Limit:1}))).Items?.[0]}catch(c){return console.error("Failed to look up document for delete:",c.message),a(500,{error:"Failed to delete document"})}if(!o)return a(404,{error:"Document not found"});let r=o.sk,s=o.objectKey;if(!s.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{await D.send(new f.DeleteObjectCommand({Bucket:N,Key:s}))}catch(c){console.error("Failed to delete S3 object:",c.message)}try{await w.send(new p.DeleteCommand({TableName:P,Key:{userId:t,sk:r}}))}catch(c){return console.error("Failed to delete metadata record:",c.message),a(500,{error:"Failed to delete document metadata"})}return a(200,{docId:n,appliedTotals:o.appliedTotals??{},deleted:!0})}var de=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return oe(e,t);case"POST /documents/extract":return re(e,t);case"POST /documents/bda-job":return a(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return le(t);case"GET /documents/{id}/download-url":return ce(e,t);case"DELETE /documents/{id}":return ue(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
