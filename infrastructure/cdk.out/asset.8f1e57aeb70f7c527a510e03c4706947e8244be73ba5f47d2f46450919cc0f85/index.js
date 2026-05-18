"use strict";var z=Object.create;var S=Object.defineProperty;var X=Object.getOwnPropertyDescriptor;var Q=Object.getOwnPropertyNames;var Z=Object.getPrototypeOf,ee=Object.prototype.hasOwnProperty;var te=(e,t)=>{for(var r in t)S(e,r,{get:t[r],enumerable:!0})},B=(e,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of Q(t))!ee.call(e,s)&&s!==r&&S(e,s,{get:()=>t[s],enumerable:!(n=X(t,s))||n.enumerable});return e};var K=(e,t,r)=>(r=e!=null?z(Z(e)):{},B(t||!e||!e.__esModule?S(r,"default",{value:e,enumerable:!0}):r,e)),ne=e=>B(S({},"__esModule",{value:!0}),e);var we={};te(we,{handler:()=>xe});module.exports=ne(we);var x=require("@aws-sdk/client-s3"),Y=require("@aws-sdk/s3-request-presigner"),N=require("@aws-sdk/client-bedrock-runtime"),q=require("@aws-sdk/client-dynamodb"),g=require("@aws-sdk/lib-dynamodb");var M=K(require("crypto")),F=new Uint8Array(256),v=F.length;function j(){return v>F.length-16&&(M.default.randomFillSync(F),v=0),F.slice(v,v+=16)}var p=[];for(let e=0;e<256;++e)p.push((e+256).toString(16).slice(1));function W(e,t=0){return p[e[t+0]]+p[e[t+1]]+p[e[t+2]]+p[e[t+3]]+"-"+p[e[t+4]]+p[e[t+5]]+"-"+p[e[t+6]]+p[e[t+7]]+"-"+p[e[t+8]]+p[e[t+9]]+"-"+p[e[t+10]]+p[e[t+11]]+p[e[t+12]]+p[e[t+13]]+p[e[t+14]]+p[e[t+15]]}var G=K(require("crypto")),U={randomUUID:G.default.randomUUID};function re(e,t,r){if(U.randomUUID&&!t&&!e)return U.randomUUID();e=e||{};let n=e.random||(e.rng||j)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){r=r||0;for(let s=0;s<16;++s)t[r+s]=n[s];return t}return W(n)}var O=re;var R=new x.S3Client({region:"us-east-1"}),oe=new N.BedrockRuntimeClient({region:"us-east-1"}),se=new q.DynamoDBClient({region:"us-east-1"}),P=g.DynamoDBDocumentClient.from(se),L=process.env.DOCS_BUCKET??"",C=process.env.TABLE_NAME??"",ae=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0",V=process.env.BEDROCK_PRO_MODEL_ID??"us.amazon.nova-pro-v1:0";function _(e,t){return t||new Set(["lease","line-of-credit","bank-statement","profit-loss","general"]).has(e)?V:ae}function o(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var ie=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function J(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var le=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function ce(e,t){if(!e.body)return o(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}if(!r.fileName)return o(400,{error:"fileName is required"});let n=J(r.fileName),s=r.contentType&&r.contentType!==""?r.contentType:n;if(!ie.includes(s))return o(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let i=le.includes(r.docType??"")?r.docType:"general",d=`${t}/${i}/${Date.now()}-${O()}-${r.fileName}`;try{let h=new x.PutObjectCommand({Bucket:L,Key:d}),f=await(0,Y.getSignedUrl)(R,h,{expiresIn:300});return o(200,{uploadUrl:f,objectKey:d,docType:i,contentType:s,expiresIn:300})}catch(h){return console.error("Failed to create pre-signed URL:",h.message),o(500,{error:"Failed to create upload URL"})}}async function ue(e,t){if(!e.body)return o(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}if(!r.objectKey)return o(400,{error:"objectKey is required"});if(!r.objectKey.startsWith(`${t}/`))return o(403,{error:"Access denied to this document"});let n,s,i=null;try{let a=await R.send(new x.GetObjectCommand({Bucket:L,Key:r.objectKey}));if(s=a.ContentType??"application/octet-stream",s==="application/octet-stream"||s==="binary/octet-stream"){let l=J(r.objectKey);l!=="application/octet-stream"&&(s=l)}if(n=await a.Body.transformToByteArray(),n.byteLength>8*1024*1024)return o(413,{error:`Document is too large for AI extraction (${Math.round(n.byteLength/1024/1024)}MB). Files must be under 8MB. For large reference documents, store them outside this app.`});(s==="text/csv"||s.startsWith("text/"))&&(i=new TextDecoder().decode(n),i.length>5e4&&(i=i.slice(0,5e4)+`

... [truncated]`))}catch(a){return console.error("Failed to read document from S3:",a.message),o(500,{error:"Failed to read uploaded document"})}function d(a){let l=[],y="uploaded-document";if(s==="application/pdf")l.push({document:{format:"pdf",name:y,source:{bytes:n}}});else if(s==="image/png"||s==="image/jpeg"||s==="image/jpg"){let m=s==="image/png"?"png":"jpeg";l.push({image:{format:m,source:{bytes:n}}})}else s==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?l.push({document:{format:"xlsx",name:y,source:{bytes:n}}}):s==="application/vnd.ms-excel"?l.push({document:{format:"xls",name:y,source:{bytes:n}}}):s==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"?l.push({document:{format:"docx",name:y,source:{bytes:n}}}):s==="application/msword"&&l.push({document:{format:"doc",name:y,source:{bytes:n}}});return l.push({text:a}),l}async function h(a,l,y){let m=new N.ConverseCommand({modelId:y,messages:[{role:"user",content:a}],inferenceConfig:{maxTokens:l,temperature:0}}),k=(await Promise.race([oe.send(m),new Promise((Te,H)=>setTimeout(()=>H(new Error("BEDROCK_TIMEOUT")),25e3))])).output?.message?.content?.[0]?.text;if(!k)throw new Error("Bedrock returned no text content");return k}let f=r.docType??"auto",w=null,b=null;if(f==="auto")try{let a=de(i),y=(await h(d(a),4096,_("auto",!0))).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),m=JSON.parse(y);w={classifiedAs:m.classifiedAs,confidence:m.classifyConfidence,rationale:m.classifyRationale,...m.bestGuessLabel&&{bestGuessLabel:m.bestGuessLabel}};let $=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];m.classifyConfidence==="low"||!$.includes(m.classifiedAs)?f="general":f=m.classifiedAs,b=m.extracted??{}}catch(a){let l=a;if(l.message==="BEDROCK_TIMEOUT")return console.error("Bedrock auto-classify timed out"),o(504,{error:"AI processing timed out. This document may be too long or complex. Try a smaller file or pick the document type manually."});console.warn("Auto classify+extract failed, falling back to general:",l.message),f="general",b=null}if(b===null){let a=me(f,i),l=d(a);try{let y=f==="bank-statement"||f==="line-of-credit",m=_(f,!1),k=(await h(l,y?4096:2048,m)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();b=JSON.parse(k)}catch(y){let m=y;return m.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock extraction timed out"),o(504,{error:"AI extraction timed out. This document may be too long. Try a smaller file or split it into pages."})):(console.error("Extraction failed:",m.message),o(502,{error:"Failed to extract data from document"}))}}let E=O(),c=new Date().toISOString(),A=r.fileName||r.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document";if(b===null)return o(502,{error:"Extraction returned no data"});let u=b,T=f==="bank-statement"||f==="line-of-credit",I=u.confidence==="low",D=T?u.categoryTotals??{}:Object.fromEntries(Object.entries(u).filter(([,a])=>typeof a=="number"&&a>0));try{await P.send(new g.PutCommand({TableName:C,Item:{userId:t,sk:`DOC#${c}#${E}`,docId:E,objectKey:r.objectKey,fileName:A,docType:f,contentType:s,uploadedAt:c,appliedTotals:D,flagged:u.flaggedTransactions??[],bankName:u.bankName??null,periodStart:u.periodStart??null,periodEnd:u.periodEnd??null,confidence:u.confidence??null,notes:u.notes??null,autoClassified:w!==null,autoClassifyResult:w??null}}))}catch(a){console.error("Failed to persist document record:",a.message)}return o(200,{docId:E,objectKey:r.objectKey,fileName:A,docType:f,contentType:s,uploadedAt:c,extracted:u,autoClassifyResult:w,isLowConfidence:I})}function de(e){return`You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

## CRITICAL \u2014 DO NOT HALLUCINATE
- Only extract figures that are CLEARLY VISIBLE in the document.
- If a number is not present, return null. Never guess. Never make up numbers.
- If the document is unrelated to small-business finance (e.g., a textbook, an ethics manual, an article, marketing material), classify it as "general" with confidence "low" and return an empty extracted object: \`{"extractedFromDocType":"general","confidence":"low","notes":"<brief description of what this document actually is>"}\`.
- Do NOT fill in placeholder or example numbers (1234567, 78901, etc.). If unsure, return null.

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
\`\`\``:""}`}function me(e,t){if(e==="bank-statement"||e==="line-of-credit")return pe(e,t);let r={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',lease:"Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent \u2014 multiply monthly rent \xD7 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year "+new Date().getFullYear()+". Do NOT include the security deposit or one-time fees in rentLeasePayments.",general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},n=r[e]??r.general,s=t?`
## Document Content (CSV)
\`\`\`
${t}
\`\`\``:"";return`You are extracting structured tax data from a ${e} document for a Foot Solutions retail franchise in Denton County, Texas.

## CRITICAL \u2014 DO NOT HALLUCINATE
- Only extract figures that are CLEARLY VISIBLE in the document.
- If a number is not present, return null. Never guess. Never make up numbers.
- Do NOT fill in placeholder or example numbers (1234567, 78901, etc.).
- If the document does not actually appear to be a ${e}, set "confidence" to "low" and return null for all fields with a note explaining what the document actually is.

${n}
${s}

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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function pe(e,t){let r=e==="line-of-credit",n=t?`
## Statement Content (CSV/text)
\`\`\`
${t}
\`\`\``:"";return`You are a CPA's automated bookkeeping assistant analyzing a ${r?"business line of credit":"business checking"} statement for a Foot Solutions retail franchise in Denton County, Texas.

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

${r?`## Line of Credit Specifics

For each line of credit payment, the statement should show interest and principal separately. If only the total payment is shown, list it in flaggedTransactions so the user can split manually.

Origination fees, draw fees, annual fees on the LOC \u2192 \`bankFees\`.`:""}

## Output Format
Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "statementType": "${r?"line-of-credit":"business-checking"}",
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

Respond with ONLY the JSON object.${n}`}async function fe(e){try{let r=((await P.send(new g.QueryCommand({TableName:C,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(n=>({docId:n.docId,fileName:n.fileName,docType:n.docType,objectKey:n.objectKey,contentType:n.contentType,uploadedAt:n.uploadedAt,appliedTotals:n.appliedTotals??{},flagged:n.flagged??[],bankName:n.bankName??null,periodStart:n.periodStart??null,periodEnd:n.periodEnd??null,confidence:n.confidence??null,notes:n.notes??null,autoClassified:n.autoClassified??!1,autoClassifyResult:n.autoClassifyResult??null}));return o(200,{documents:r})}catch(t){return console.error("Failed to list documents:",t.message),o(500,{error:"Failed to list documents"})}}async function ye(e,t){let r=e.pathParameters?.id;if(!r)return o(400,{error:"Document id is required"});let n;try{n=(await P.send(new g.QueryCommand({TableName:C,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(i){return console.error("Failed to look up document:",i.message),o(500,{error:"Failed to look up document"})}if(!n)return o(404,{error:"Document not found"});let s=n.objectKey;if(!s.startsWith(`${t}/`))return o(403,{error:"Access denied"});try{let i=new x.GetObjectCommand({Bucket:L,Key:s}),d=await(0,Y.getSignedUrl)(R,i,{expiresIn:300});return o(200,{downloadUrl:d,fileName:n.fileName,expiresIn:300})}catch(i){return console.error("Failed to create download URL:",i.message),o(500,{error:"Failed to create download URL"})}}async function ge(e,t){let r=e.pathParameters?.id;if(!r)return o(400,{error:"Document id is required"});let n;try{n=(await P.send(new g.QueryCommand({TableName:C,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(d){return console.error("Failed to look up document for delete:",d.message),o(500,{error:"Failed to delete document"})}if(!n)return o(404,{error:"Document not found"});let s=n.sk,i=n.objectKey;if(!i.startsWith(`${t}/`))return o(403,{error:"Access denied"});try{await R.send(new x.DeleteObjectCommand({Bucket:L,Key:i}))}catch(d){console.error("Failed to delete S3 object:",d.message)}try{await P.send(new g.DeleteCommand({TableName:C,Key:{userId:t,sk:s}}))}catch(d){return console.error("Failed to delete metadata record:",d.message),o(500,{error:"Failed to delete document metadata"})}return o(200,{docId:r,appliedTotals:n.appliedTotals??{},deleted:!0})}var he=new Set(["rentLeasePayments","utilities","businessInsurancePremiums","professionalFees","marketingAdvertising","officeSupplies","bankFees","softwareSubscriptions","royaltyFees","adFundContributions","loanInterestPaid","loanPrincipalPaid","totalEmployeeWages","employerHealthInsurance","total1099Payments","totalEquipmentCost","ownerHealthInsurancePremiums","cogs","totalRevenue","salesTaxCollected","salesTaxRemitted"]);async function be(e,t){let r=e.pathParameters?.id,n=e.pathParameters?.index;if(!r)return o(400,{error:"Document id is required"});if(!n)return o(400,{error:"Flagged index is required"});let s=Number(n);if(!Number.isInteger(s)||s<0)return o(400,{error:"Flagged index must be a non-negative integer"});if(!e.body)return o(400,{error:"Request body is required"});let i;try{i=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}let d=i.action;if(d!=="apply"&&d!=="ignore"&&d!=="unresolve")return o(400,{error:"action must be 'apply', 'ignore', or 'unresolve'"});let h;try{h=(await P.send(new g.QueryCommand({TableName:C,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(a){return console.error("Failed to look up document for resolve:",a.message),o(500,{error:"Failed to read document"})}if(!h)return o(404,{error:"Document not found"});let f=h.sk,w=h.flagged??[];if(s>=w.length)return o(404,{error:"Flagged transaction index out of range"});let b=w[s],E=Math.abs(Number(b.amount??0)),c=b.resolution,A=h.appliedTotals??{},u={...A},T=null;if(d==="unresolve"){if(!c)return o(400,{error:"Item is not currently resolved"});if(c.action==="apply"&&c.field&&typeof c.appliedAmount=="number"){let a=u[c.field]??0,l=Math.max(0,a-c.appliedAmount);l===0?delete u[c.field]:u[c.field]=l}T=null}else if(d==="apply"){if(!i.field||!he.has(i.field))return o(400,{error:"field is required and must be one of the supported tax-form fields"});let a=typeof i.appliedAmount=="number"&&i.appliedAmount>0?i.appliedAmount:E;if(a<=0)return o(400,{error:"amount must be positive"});if(c?.action==="apply"&&c.field&&typeof c.appliedAmount=="number"){let l=u[c.field]??0;u[c.field]=Math.max(0,l-c.appliedAmount)}u[i.field]=(u[i.field]??0)+a,T={action:"apply",field:i.field,appliedAmount:a,resolvedAt:new Date().toISOString()}}else{if(c?.action==="apply"&&c.field&&typeof c.appliedAmount=="number"){let a=u[c.field]??0,l=Math.max(0,a-c.appliedAmount);l===0?delete u[c.field]:u[c.field]=l}T={action:"ignore",resolvedAt:new Date().toISOString()}}let I=w.slice();I[s]=T?{...b,resolution:T}:(()=>{let a={...b};return delete a.resolution,a})();try{await P.send(new g.UpdateCommand({TableName:C,Key:{userId:t,sk:f},UpdateExpression:"SET flagged = :f, appliedTotals = :a",ExpressionAttributeValues:{":f":I,":a":u}}))}catch(a){return console.error("Failed to update flagged resolution:",a.message),o(500,{error:"Failed to save resolution"})}let D={};for(let a of new Set([...Object.keys(A),...Object.keys(u)])){let l=A[a]??0,y=u[a]??0;l!==y&&(D[a]=y-l)}return o(200,{docId:r,index:s,resolution:T,appliedTotals:u,formDelta:D})}var xe=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return ce(e,t);case"POST /documents/extract":return ue(e,t);case"POST /documents/bda-job":return o(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return fe(t);case"GET /documents/{id}/download-url":return ye(e,t);case"DELETE /documents/{id}":return ge(e,t);case"POST /documents/{id}/flagged/{index}/resolve":return be(e,t);default:return o(404,{error:"Route not found"})}};0&&(module.exports={handler});
