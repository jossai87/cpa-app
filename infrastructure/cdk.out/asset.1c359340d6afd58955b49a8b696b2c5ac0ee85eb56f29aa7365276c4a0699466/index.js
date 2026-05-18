"use strict";var V=Object.create;var C=Object.defineProperty;var _=Object.getOwnPropertyDescriptor;var q=Object.getOwnPropertyNames;var J=Object.getPrototypeOf,H=Object.prototype.hasOwnProperty;var z=(e,t)=>{for(var o in t)C(e,o,{get:t[o],enumerable:!0})},$=(e,t,o,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of q(t))!H.call(e,r)&&r!==o&&C(e,r,{get:()=>t[r],enumerable:!(n=_(t,r))||n.enumerable});return e};var j=(e,t,o)=>(o=e!=null?V(J(e)):{},$(t||!e||!e.__esModule?C(o,"default",{value:e,enumerable:!0}):o,e)),X=e=>$(C({},"__esModule",{value:!0}),e);var pe={};z(pe,{handler:()=>me});module.exports=X(pe);var y=require("@aws-sdk/client-s3"),L=require("@aws-sdk/s3-request-presigner"),k=require("@aws-sdk/client-bedrock-runtime"),K=require("@aws-sdk/client-dynamodb"),p=require("@aws-sdk/lib-dynamodb");var B=j(require("crypto")),S=new Uint8Array(256),E=S.length;function v(){return E>S.length-16&&(B.default.randomFillSync(S),E=0),S.slice(E,E+=16)}var c=[];for(let e=0;e<256;++e)c.push((e+256).toString(16).slice(1));function U(e,t=0){return c[e[t+0]]+c[e[t+1]]+c[e[t+2]]+c[e[t+3]]+"-"+c[e[t+4]]+c[e[t+5]]+"-"+c[e[t+6]]+c[e[t+7]]+"-"+c[e[t+8]]+c[e[t+9]]+"-"+c[e[t+10]]+c[e[t+11]]+c[e[t+12]]+c[e[t+13]]+c[e[t+14]]+c[e[t+15]]}var Y=j(require("crypto")),O={randomUUID:Y.default.randomUUID};function Q(e,t,o){if(O.randomUUID&&!t&&!e)return O.randomUUID();e=e||{};let n=e.random||(e.rng||v)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){o=o||0;for(let r=0;r<16;++r)t[o+r]=n[r];return t}return U(n)}var D=Q;var A=new y.S3Client({region:"us-east-1"}),Z=new k.BedrockRuntimeClient({region:"us-east-1"}),ee=new K.DynamoDBClient({region:"us-east-1"}),w=p.DynamoDBDocumentClient.from(ee),F=process.env.DOCS_BUCKET??"",T=process.env.TABLE_NAME??"",te=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var ne=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function M(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var oe=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function re(e,t){if(!e.body)return a(400,{error:"Request body is required"});let o;try{o=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!o.fileName)return a(400,{error:"fileName is required"});let n=M(o.fileName),r=o.contentType&&o.contentType!==""?o.contentType:n;if(!ne.includes(r))return a(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let s=oe.includes(o.docType??"")?o.docType:"general",d=`${t}/${s}/${Date.now()}-${D()}-${o.fileName}`;try{let h=new y.PutObjectCommand({Bucket:F,Key:d}),m=await(0,L.getSignedUrl)(A,h,{expiresIn:300});return a(200,{uploadUrl:m,objectKey:d,docType:s,contentType:r,expiresIn:300})}catch(h){return console.error("Failed to create pre-signed URL:",h.message),a(500,{error:"Failed to create upload URL"})}}async function ae(e,t){if(!e.body)return a(400,{error:"Request body is required"});let o;try{o=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!o.objectKey)return a(400,{error:"objectKey is required"});if(!o.objectKey.startsWith(`${t}/`))return a(403,{error:"Access denied to this document"});let n,r,s=null;try{let i=await A.send(new y.GetObjectCommand({Bucket:F,Key:o.objectKey}));if(r=i.ContentType??"application/octet-stream",r==="application/octet-stream"||r==="binary/octet-stream"){let l=M(o.objectKey);l!=="application/octet-stream"&&(r=l)}if(n=await i.Body.transformToByteArray(),n.byteLength>8*1024*1024)return a(413,{error:`Document is too large for AI extraction (${Math.round(n.byteLength/1024/1024)}MB). Files must be under 8MB. For large reference documents, store them outside this app.`});(r==="text/csv"||r.startsWith("text/"))&&(s=new TextDecoder().decode(n),s.length>5e4&&(s=s.slice(0,5e4)+`

... [truncated]`))}catch(i){return console.error("Failed to read document from S3:",i.message),a(500,{error:"Failed to read uploaded document"})}function d(i){let l=[];if(r==="application/pdf")l.push({document:{format:"pdf",name:"uploaded-document",source:{bytes:Buffer.from(n).toString("base64")}}});else if(r==="image/png"||r==="image/jpeg"||r==="image/jpg"){let g=r==="image/png"?"png":"jpeg";l.push({image:{format:g,source:{bytes:Buffer.from(n).toString("base64")}}})}else r==="application/vnd.ms-excel"||r==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?l.push({document:{format:"xlsx",name:"uploaded-document",source:{bytes:Buffer.from(n).toString("base64")}}}):(r==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"||r==="application/msword")&&l.push({document:{format:"docx",name:"uploaded-document",source:{bytes:Buffer.from(n).toString("base64")}}});return l.push({text:i}),l}async function h(i,l){let g={messages:[{role:"user",content:i}],inferenceConfig:{maxTokens:l,temperature:0}},u=new k.InvokeModelCommand({modelId:te,contentType:"application/json",accept:"application/json",body:JSON.stringify(g)}),x=await Promise.race([Z.send(u),new Promise((ge,W)=>setTimeout(()=>W(new Error("BEDROCK_TIMEOUT")),25e3))]);return JSON.parse(new TextDecoder().decode(x.body)).output.message.content[0].text}let m=o.docType??"auto",P=null,b=null;if(m==="auto")try{let i=se(s),g=(await h(d(i),4096)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),u=JSON.parse(g);P={classifiedAs:u.classifiedAs,confidence:u.classifyConfidence,rationale:u.classifyRationale,...u.bestGuessLabel&&{bestGuessLabel:u.bestGuessLabel}};let x=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];u.classifyConfidence==="low"||!x.includes(u.classifiedAs)?m="general":m=u.classifiedAs,b=u.extracted??{}}catch(i){let l=i;if(l.message==="BEDROCK_TIMEOUT")return console.error("Bedrock auto-classify timed out"),a(504,{error:"AI processing timed out. This document may be too long or complex. Try a smaller file or pick the document type manually."});console.warn("Auto classify+extract failed, falling back to general:",l.message),m="general",b=null}if(b===null){let i=ie(m,s),l=d(i);try{let x=(await h(l,m==="bank-statement"||m==="line-of-credit"?4096:2048)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();b=JSON.parse(x)}catch(g){let u=g;return u.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock extraction timed out"),a(504,{error:"AI extraction timed out. This document may be too long. Try a smaller file or split it into pages."})):(console.error("Extraction failed:",u.message),a(502,{error:"Failed to extract data from document"}))}}let I=D(),N=new Date().toISOString(),R=o.fileName||o.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document",f=b,G=m==="bank-statement"||m==="line-of-credit"?f.categoryTotals??{}:Object.fromEntries(Object.entries(f).filter(([,i])=>typeof i=="number"&&i>0));try{await w.send(new p.PutCommand({TableName:T,Item:{userId:t,sk:`DOC#${N}#${I}`,docId:I,objectKey:o.objectKey,fileName:R,docType:m,contentType:r,uploadedAt:N,appliedTotals:G,flagged:f.flaggedTransactions??[],bankName:f.bankName??null,periodStart:f.periodStart??null,periodEnd:f.periodEnd??null,confidence:f.confidence??null,notes:f.notes??null,autoClassified:P!==null,autoClassifyResult:P??null}}))}catch(i){console.error("Failed to persist document record:",i.message)}return a(200,{docId:I,objectKey:o.objectKey,fileName:R,docType:m,contentType:r,uploadedAt:N,extracted:b,autoClassifyResult:P})}function se(e){return`You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

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

**lease:** Use this exact \`extracted\` shape \u2014 \`rentLeasePayments\` MUST be the annual base rent (multiply monthly \xD7 12 if needed), and \`notes\` describes lease term/dates/escalation:
{
  "rentLeasePayments": <annual rent in dollars>,
  "extractedFromDocType": "lease",
  "confidence": "high|medium|low",
  "notes": "<lease term, start/end dates, security deposit, escalation, CAM>"
}
Do NOT include security deposit in rentLeasePayments. If the lease has escalating rent across years, use the rent for the CURRENT calendar year (2026).

**insurance:** Use this exact \`extracted\` shape:
{
  "businessInsurancePremiums": <total annual premium>,
  "extractedFromDocType": "insurance",
  "confidence": "high|medium|low",
  "notes": "<short caveat>"
}

**profit-loss:** Use this \`extracted\` shape with whatever fields you can find (null for missing):
{
  "totalRevenue": <num|null>, "cogs": <num|null>, "totalOperatingExpenses": <num|null>,
  "rentLeasePayments": <num|null>, "utilities": <num|null>, "businessInsurancePremiums": <num|null>,
  "marketingAdvertising": <num|null>, "professionalFees": <num|null>, "totalEmployeeWages": <num|null>,
  "extractedFromDocType": "profit-loss", "confidence": "high|medium|low", "notes": "<>"
}

**royalty-statement:** \`{"totalRevenue": <num>, "royaltyFees": <num>, "adFundContributions": <num>, "extractedFromDocType":"royalty-statement", "confidence":"...", "notes":"<>"}\`

**sales-tax-return:** \`{"totalRevenue": <num>, "salesTaxCollected": <num>, "salesTaxRemitted": <num>, "extractedFromDocType":"sales-tax-return", "confidence":"...", "notes":"<>"}\`

**payroll-summary:** \`{"totalEmployeeWages": <num>, "employerPayrollTaxes": <num>, "employeeCount": <num>, "retirementPlanContributions": <num>, "employerHealthInsurance": <num>, "extractedFromDocType":"payroll-summary", "confidence":"...", "notes":"<>"}\`

**fixed-assets:** \`{"totalEquipmentCost": <num>, "extractedFromDocType":"fixed-assets", "confidence":"...", "notes":"<>"}\`

**general:** Best-effort extraction \u2014 \`{"extractedFromDocType":"general", "confidence":"...", "notes":"<what the document is and what figures could be found>"}\`

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
\`\`\``:""}`}function ie(e,t){if(e==="bank-statement"||e==="line-of-credit")return le(e,t);let o={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',lease:"Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent \u2014 multiply monthly rent \xD7 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year "+new Date().getFullYear()+". Do NOT include the security deposit or one-time fees in rentLeasePayments.",general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},n=o[e]??o.general,r=t?`
## Document Content (CSV)
\`\`\`
${t}
\`\`\``:"";return`You are extracting structured tax data from a ${e} document for a Foot Solutions retail franchise in Denton County, Texas.

${n}
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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function le(e,t){let o=e==="line-of-credit",n=t?`
## Statement Content (CSV/text)
\`\`\`
${t}
\`\`\``:"";return`You are a CPA's automated bookkeeping assistant analyzing a ${o?"business line of credit":"business checking"} statement for a Foot Solutions retail franchise in Denton County, Texas.

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

${o?`## Line of Credit Specifics

For each line of credit payment, the statement should show interest and principal separately. If only the total payment is shown, list it in flaggedTransactions so the user can split manually.

Origination fees, draw fees, annual fees on the LOC \u2192 \`bankFees\`.`:""}

## Output Format
Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "statementType": "${o?"line-of-credit":"business-checking"}",
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

Respond with ONLY the JSON object.${n}`}async function ce(e){try{let o=((await w.send(new p.QueryCommand({TableName:T,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(n=>({docId:n.docId,fileName:n.fileName,docType:n.docType,objectKey:n.objectKey,contentType:n.contentType,uploadedAt:n.uploadedAt,appliedTotals:n.appliedTotals??{},flagged:n.flagged??[],bankName:n.bankName??null,periodStart:n.periodStart??null,periodEnd:n.periodEnd??null,confidence:n.confidence??null,notes:n.notes??null,autoClassified:n.autoClassified??!1,autoClassifyResult:n.autoClassifyResult??null}));return a(200,{documents:o})}catch(t){return console.error("Failed to list documents:",t.message),a(500,{error:"Failed to list documents"})}}async function ue(e,t){let o=e.pathParameters?.id;if(!o)return a(400,{error:"Document id is required"});let n;try{n=(await w.send(new p.QueryCommand({TableName:T,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":o},Limit:1}))).Items?.[0]}catch(s){return console.error("Failed to look up document:",s.message),a(500,{error:"Failed to look up document"})}if(!n)return a(404,{error:"Document not found"});let r=n.objectKey;if(!r.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{let s=new y.GetObjectCommand({Bucket:F,Key:r}),d=await(0,L.getSignedUrl)(A,s,{expiresIn:300});return a(200,{downloadUrl:d,fileName:n.fileName,expiresIn:300})}catch(s){return console.error("Failed to create download URL:",s.message),a(500,{error:"Failed to create download URL"})}}async function de(e,t){let o=e.pathParameters?.id;if(!o)return a(400,{error:"Document id is required"});let n;try{n=(await w.send(new p.QueryCommand({TableName:T,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":o},Limit:1}))).Items?.[0]}catch(d){return console.error("Failed to look up document for delete:",d.message),a(500,{error:"Failed to delete document"})}if(!n)return a(404,{error:"Document not found"});let r=n.sk,s=n.objectKey;if(!s.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{await A.send(new y.DeleteObjectCommand({Bucket:F,Key:s}))}catch(d){console.error("Failed to delete S3 object:",d.message)}try{await w.send(new p.DeleteCommand({TableName:T,Key:{userId:t,sk:r}}))}catch(d){return console.error("Failed to delete metadata record:",d.message),a(500,{error:"Failed to delete document metadata"})}return a(200,{docId:o,appliedTotals:n.appliedTotals??{},deleted:!0})}var me=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return re(e,t);case"POST /documents/extract":return ae(e,t);case"POST /documents/bda-job":return a(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return ce(t);case"GET /documents/{id}/download-url":return ue(e,t);case"DELETE /documents/{id}":return de(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
