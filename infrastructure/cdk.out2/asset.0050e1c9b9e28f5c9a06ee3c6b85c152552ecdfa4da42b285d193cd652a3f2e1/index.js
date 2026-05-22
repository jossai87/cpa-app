"use strict";var z=Object.create;var N=Object.defineProperty;var X=Object.getOwnPropertyDescriptor;var Q=Object.getOwnPropertyNames;var Z=Object.getPrototypeOf,ee=Object.prototype.hasOwnProperty;var te=(e,t)=>{for(var r in t)N(e,r,{get:t[r],enumerable:!0})},G=(e,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of Q(t))!ee.call(e,s)&&s!==r&&N(e,s,{get:()=>t[s],enumerable:!(n=X(t,s))||n.enumerable});return e};var Y=(e,t,r)=>(r=e!=null?z(Z(e)):{},G(t||!e||!e.__esModule?N(r,"default",{value:e,enumerable:!0}):r,e)),ne=e=>G(N({},"__esModule",{value:!0}),e);var Pe={};te(Pe,{handler:()=>Te});module.exports=ne(Pe);var T=require("@aws-sdk/client-s3"),U=require("@aws-sdk/s3-request-presigner"),L=require("@aws-sdk/client-bedrock-runtime"),J=require("@aws-sdk/client-dynamodb"),h=require("@aws-sdk/lib-dynamodb");var M=Y(require("crypto")),R=new Uint8Array(256),O=R.length;function $(){return O>R.length-16&&(M.default.randomFillSync(R),O=0),R.slice(O,O+=16)}var f=[];for(let e=0;e<256;++e)f.push((e+256).toString(16).slice(1));function W(e,t=0){return f[e[t+0]]+f[e[t+1]]+f[e[t+2]]+f[e[t+3]]+"-"+f[e[t+4]]+f[e[t+5]]+"-"+f[e[t+6]]+f[e[t+7]]+"-"+f[e[t+8]]+f[e[t+9]]+"-"+f[e[t+10]]+f[e[t+11]]+f[e[t+12]]+f[e[t+13]]+f[e[t+14]]+f[e[t+15]]}var V=Y(require("crypto")),K={randomUUID:V.default.randomUUID};function re(e,t,r){if(K.randomUUID&&!t&&!e)return K.randomUUID();e=e||{};let n=e.random||(e.rng||$)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){r=r||0;for(let s=0;s<16;++s)t[r+s]=n[s];return t}return W(n)}var I=re;var k=new T.S3Client({region:"us-east-1"}),oe=new L.BedrockRuntimeClient({region:"us-east-1"}),se=new J.DynamoDBClient({region:"us-east-1"}),x=h.DynamoDBDocumentClient.from(se),S=process.env.DOCS_BUCKET??"",w=process.env.TABLE_NAME??"",ae=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0",q=process.env.BEDROCK_PRO_MODEL_ID??"us.amazon.nova-pro-v1:0";function _(e,t){return t||new Set(["lease","line-of-credit","bank-statement","profit-loss","general"]).has(e)?q:ae}function o(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var ie=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function B(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var le=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function ue(e,t){if(!e.body)return o(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}if(!r.fileName)return o(400,{error:"fileName is required"});let n=B(r.fileName),s=r.contentType&&r.contentType!==""?r.contentType:n;if(!ie.includes(s))return o(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let i=le.includes(r.docType??"")?r.docType:"general",l=`${t}/${i}/${Date.now()}-${I()}-${r.fileName}`;try{let c=new T.PutObjectCommand({Bucket:S,Key:l}),y=await(0,U.getSignedUrl)(k,c,{expiresIn:300});return o(200,{uploadUrl:y,objectKey:l,docType:i,contentType:s,expiresIn:300})}catch(c){return console.error("Failed to create pre-signed URL:",c.message),o(500,{error:"Failed to create upload URL"})}}async function ce(e,t){if(!e.body)return o(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}if(!r.objectKey)return o(400,{error:"objectKey is required"});if(!r.objectKey.startsWith(`${t}/`))return o(403,{error:"Access denied to this document"});let n,s,i=null;try{let a=await k.send(new T.GetObjectCommand({Bucket:S,Key:r.objectKey}));if(s=a.ContentType??"application/octet-stream",s==="application/octet-stream"||s==="binary/octet-stream"){let u=B(r.objectKey);u!=="application/octet-stream"&&(s=u)}if(n=await a.Body.transformToByteArray(),n.byteLength>8*1024*1024)return o(413,{error:`Document is too large for AI extraction (${Math.round(n.byteLength/1024/1024)}MB). Files must be under 8MB. For large reference documents, store them outside this app.`});(s==="text/csv"||s.startsWith("text/"))&&(i=new TextDecoder().decode(n),i.length>5e4&&(i=i.slice(0,5e4)+`

... [truncated]`))}catch(a){return console.error("Failed to read document from S3:",a.message),o(500,{error:"Failed to read uploaded document"})}function l(a){let u=[],g="uploaded-document";if(s==="application/pdf")u.push({document:{format:"pdf",name:g,source:{bytes:n}}});else if(s==="image/png"||s==="image/jpeg"||s==="image/jpg"){let p=s==="image/png"?"png":"jpeg";u.push({image:{format:p,source:{bytes:n}}})}else s==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?u.push({document:{format:"xlsx",name:g,source:{bytes:n}}}):s==="application/vnd.ms-excel"?u.push({document:{format:"xls",name:g,source:{bytes:n}}}):s==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"?u.push({document:{format:"docx",name:g,source:{bytes:n}}}):s==="application/msword"&&u.push({document:{format:"doc",name:g,source:{bytes:n}}});return u.push({text:a}),u}async function c(a,u,g){let p=new L.ConverseCommand({modelId:g,messages:[{role:"user",content:a}],inferenceConfig:{maxTokens:u,temperature:0}}),F=(await Promise.race([oe.send(p),new Promise((Ce,H)=>setTimeout(()=>H(new Error("BEDROCK_TIMEOUT")),25e3))])).output?.message?.content?.[0]?.text;if(!F)throw new Error("Bedrock returned no text content");return F}let y=r.docType??"auto",P=null,b=null;if(y==="auto")try{let a=de(i),g=(await c(l(a),4096,_("auto",!0))).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),p=JSON.parse(g);P={classifiedAs:p.classifiedAs,confidence:p.classifyConfidence,rationale:p.classifyRationale,...p.bestGuessLabel&&{bestGuessLabel:p.bestGuessLabel}};let j=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];p.classifyConfidence==="low"||!j.includes(p.classifiedAs)?y="general":y=p.classifiedAs,b=p.extracted??{}}catch(a){let u=a;if(u.message==="BEDROCK_TIMEOUT")return console.error("Bedrock auto-classify timed out"),o(504,{error:"AI processing timed out. This document may be too long or complex. Try a smaller file or pick the document type manually."});console.warn("Auto classify+extract failed, falling back to general:",u.message),y="general",b=null}if(b===null){let a=me(y,i),u=l(a);try{let g=y==="bank-statement"||y==="line-of-credit",p=_(y,!1),F=(await c(u,g?4096:2048,p)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();b=JSON.parse(F)}catch(g){let p=g;return p.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock extraction timed out"),o(504,{error:"AI extraction timed out. This document may be too long. Try a smaller file or split it into pages."})):(console.error("Extraction failed:",p.message),o(502,{error:"Failed to extract data from document"}))}}let E=I(),d=new Date().toISOString(),A=r.fileName||r.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document";if(b===null)return o(502,{error:"Extraction returned no data"});let m=b,C=y==="bank-statement"||y==="line-of-credit",D=m.confidence==="low",v=C?m.categoryTotals??{}:Object.fromEntries(Object.entries(m).filter(([,a])=>typeof a=="number"&&a>0));try{await x.send(new h.PutCommand({TableName:w,Item:{userId:t,sk:`DOC#${d}#${E}`,docId:E,objectKey:r.objectKey,fileName:A,docType:y,contentType:s,uploadedAt:d,appliedTotals:v,flagged:m.flaggedTransactions??[],bankName:m.bankName??null,periodStart:m.periodStart??null,periodEnd:m.periodEnd??null,confidence:m.confidence??null,notes:m.notes??null,autoClassified:P!==null,autoClassifyResult:P??null}}))}catch(a){console.error("Failed to persist document record:",a.message)}return o(200,{docId:E,objectKey:r.objectKey,fileName:A,docType:y,contentType:s,uploadedAt:d,extracted:m,autoClassifyResult:P,isLowConfidence:D})}function de(e){return`You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

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
  "flaggedTransactions": [{"date":"YYYY-MM-DD","description":"<>","amount":<n>,"reason":"<>","bestGuessField":"<key|null>","guessConfidence":"high|medium|low"}],
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
8. **Large supplier wire transfers (Fedwire, ACH to wholesalers)** for a retail business are most likely inventory purchases \u2192 for flagged items, use \`cogs\` as the bestGuessField.
9. **Anything truly ambiguous** \u2192 leave it out of categoryTotals and add it to flaggedTransactions with:
   - a one-line reason
   - a \`bestGuessField\` containing the SINGLE most-likely tax-form field name from the table above (or \`cogs\`, \`totalRevenue\`, \`salesTaxCollected\`, \`salesTaxRemitted\` \u2014 these are valid fields too). Use \`null\` only if you genuinely have no guess.
   - a \`guessConfidence\` value of "high", "medium", or "low".

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
    {"date": "YYYY-MM-DD", "description": "<merchant>", "amount": <number>, "reason": "<short reason>", "bestGuessField": "<one of the keys above, or null>", "guessConfidence": "high|medium|low"}
  ],
  "totalDeposits": <sum of all inflows or 0>,
  "totalWithdrawals": <sum of all outflows or 0>,
  "confidence": "high|medium|low",
  "notes": "<short caveat>"
}

All amounts MUST be plain positive numbers (no $, no commas, no cents \u2014 round to nearest dollar). Categories with $0 should be 0, not null. Set fields you cannot determine to null where allowed.

Respond with ONLY the JSON object.${n}`}async function fe(e){try{let r=((await x.send(new h.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(n=>({docId:n.docId,fileName:n.fileName,docType:n.docType,objectKey:n.objectKey,contentType:n.contentType,uploadedAt:n.uploadedAt,appliedTotals:n.appliedTotals??{},flagged:n.flagged??[],bankName:n.bankName??null,periodStart:n.periodStart??null,periodEnd:n.periodEnd??null,confidence:n.confidence??null,notes:n.notes??null,autoClassified:n.autoClassified??!1,autoClassifyResult:n.autoClassifyResult??null}));return o(200,{documents:r})}catch(t){return console.error("Failed to list documents:",t.message),o(500,{error:"Failed to list documents"})}}async function ye(e,t){let r=e.pathParameters?.id;if(!r)return o(400,{error:"Document id is required"});let n;try{n=(await x.send(new h.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(i){return console.error("Failed to look up document:",i.message),o(500,{error:"Failed to look up document"})}if(!n)return o(404,{error:"Document not found"});if(n.docType==="pos-import"&&n.posImportSummary)return o(200,{inline:!0,fileName:n.fileName,contentType:"application/json",content:JSON.stringify(n.posImportSummary,null,2)});let s=n.objectKey;if(!s.startsWith(`${t}/`))return o(403,{error:"Access denied"});try{let i=new T.GetObjectCommand({Bucket:S,Key:s}),l=await(0,U.getSignedUrl)(k,i,{expiresIn:300});return o(200,{downloadUrl:l,fileName:n.fileName,expiresIn:300})}catch(i){return console.error("Failed to create download URL:",i.message),o(500,{error:"Failed to create download URL"})}}async function ge(e,t){let r=e.pathParameters?.id;if(!r)return o(400,{error:"Document id is required"});let n;try{n=(await x.send(new h.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(c){return console.error("Failed to look up document for delete:",c.message),o(500,{error:"Failed to delete document"})}if(!n)return o(404,{error:"Document not found"});let s=n.sk,i=n.objectKey,l=n.docType==="pos-import";if(!l&&!i.startsWith(`${t}/`))return o(403,{error:"Access denied"});if(!l)try{await k.send(new T.DeleteObjectCommand({Bucket:S,Key:i}))}catch(c){console.error("Failed to delete S3 object:",c.message)}try{await x.send(new h.DeleteCommand({TableName:w,Key:{userId:t,sk:s}}))}catch(c){return console.error("Failed to delete metadata record:",c.message),o(500,{error:"Failed to delete document metadata"})}return o(200,{docId:r,appliedTotals:n.appliedTotals??{},deleted:!0})}async function he(e){let t=[];try{t=(await x.send(new h.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"}}))).Items??[]}catch(l){return console.error("Failed to list documents for bulk delete:",l.message),o(500,{error:"Failed to list documents"})}if(t.length===0)return o(200,{deletedCount:0});let n=(await Promise.allSettled(t.map(l=>{if(l.docType==="pos-import")return Promise.resolve();let c=l.objectKey;return!c||!c.startsWith(`${e}/`)?Promise.reject(new Error("Invalid object key")):k.send(new T.DeleteObjectCommand({Bucket:S,Key:c}))}))).filter(l=>l.status==="rejected").length;n>0&&console.warn(`Bulk delete: ${n}/${t.length} S3 deletes failed (continuing with metadata cleanup)`);let i=(await Promise.allSettled(t.map(l=>x.send(new h.DeleteCommand({TableName:w,Key:{userId:e,sk:l.sk}}))))).filter(l=>l.status==="rejected").length;return i>0?(console.error(`Bulk delete: ${i}/${t.length} DynamoDB deletes failed`),o(500,{error:`Deleted ${t.length-i} of ${t.length} documents. Some metadata could not be removed \u2014 try again.`})):o(200,{deletedCount:t.length,s3FailureCount:n})}var be=new Set(["rentLeasePayments","utilities","businessInsurancePremiums","professionalFees","marketingAdvertising","officeSupplies","bankFees","softwareSubscriptions","royaltyFees","adFundContributions","loanInterestPaid","loanPrincipalPaid","totalEmployeeWages","employerHealthInsurance","total1099Payments","totalEquipmentCost","ownerHealthInsurancePremiums","cogs","totalRevenue","salesTaxCollected","salesTaxRemitted"]);async function xe(e,t){let r=e.pathParameters?.id,n=e.pathParameters?.index;if(!r)return o(400,{error:"Document id is required"});if(!n)return o(400,{error:"Flagged index is required"});let s=Number(n);if(!Number.isInteger(s)||s<0)return o(400,{error:"Flagged index must be a non-negative integer"});if(!e.body)return o(400,{error:"Request body is required"});let i;try{i=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}let l=i.action;if(l!=="apply"&&l!=="ignore"&&l!=="unresolve")return o(400,{error:"action must be 'apply', 'ignore', or 'unresolve'"});let c;try{c=(await x.send(new h.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(a){return console.error("Failed to look up document for resolve:",a.message),o(500,{error:"Failed to read document"})}if(!c)return o(404,{error:"Document not found"});let y=c.sk,P=c.flagged??[];if(s>=P.length)return o(404,{error:"Flagged transaction index out of range"});let b=P[s],E=Math.abs(Number(b.amount??0)),d=b.resolution,A=c.appliedTotals??{},m={...A},C=null;if(l==="unresolve"){if(!d)return o(400,{error:"Item is not currently resolved"});if(d.action==="apply"&&d.field&&typeof d.appliedAmount=="number"){let a=m[d.field]??0,u=Math.max(0,a-d.appliedAmount);u===0?delete m[d.field]:m[d.field]=u}C=null}else if(l==="apply"){if(!i.field||!be.has(i.field))return o(400,{error:"field is required and must be one of the supported tax-form fields"});let a=typeof i.appliedAmount=="number"&&i.appliedAmount>0?i.appliedAmount:E;if(a<=0)return o(400,{error:"amount must be positive"});if(d?.action==="apply"&&d.field&&typeof d.appliedAmount=="number"){let u=m[d.field]??0;m[d.field]=Math.max(0,u-d.appliedAmount)}m[i.field]=(m[i.field]??0)+a,C={action:"apply",field:i.field,appliedAmount:a,resolvedAt:new Date().toISOString()}}else{if(d?.action==="apply"&&d.field&&typeof d.appliedAmount=="number"){let a=m[d.field]??0,u=Math.max(0,a-d.appliedAmount);u===0?delete m[d.field]:m[d.field]=u}C={action:"ignore",resolvedAt:new Date().toISOString()}}let D=P.slice();D[s]=C?{...b,resolution:C}:(()=>{let a={...b};return delete a.resolution,a})();try{await x.send(new h.UpdateCommand({TableName:w,Key:{userId:t,sk:y},UpdateExpression:"SET flagged = :f, appliedTotals = :a",ExpressionAttributeValues:{":f":D,":a":m}}))}catch(a){return console.error("Failed to update flagged resolution:",a.message),o(500,{error:"Failed to save resolution"})}let v={};for(let a of new Set([...Object.keys(A),...Object.keys(m)])){let u=A[a]??0,g=m[a]??0;u!==g&&(v[a]=g-u)}return o(200,{docId:r,index:s,resolution:C,appliedTotals:m,formDelta:v})}async function we(e,t){if(!e.body)return o(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return o(400,{error:"Invalid JSON in request body"})}if(!r.objectKey)return o(400,{error:"objectKey is required"});if(!r.objectKey.startsWith(`${t}/`))return o(403,{error:"Access denied to this document"});let n=I(),s=new Date().toISOString(),i=r.fileName??r.objectKey.split("/").pop()??"supporting-document",l=r.contentType??B(i);try{await x.send(new h.PutCommand({TableName:w,Item:{userId:t,sk:`DOC#${s}#${n}`,docId:n,objectKey:r.objectKey,fileName:i,docType:"cpa-supporting",contentType:l,uploadedAt:s,appliedTotals:{},flagged:[],bankName:null,periodStart:null,periodEnd:null,confidence:null,notes:r.notes??null,autoClassified:!1,autoClassifyResult:null}}))}catch(c){return console.error("Failed to register supporting doc:",c.message),o(500,{error:"Failed to register supporting document"})}return o(200,{docId:n,objectKey:r.objectKey,fileName:i,docType:"cpa-supporting",contentType:l,uploadedAt:s})}var Te=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return ue(e,t);case"POST /documents/extract":return ce(e,t);case"POST /documents/bda-job":return o(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return fe(t);case"GET /documents/{id}/download-url":return ye(e,t);case"DELETE /documents/{id}":return ge(e,t);case"DELETE /documents":return he(t);case"POST /documents/{id}/flagged/{index}/resolve":return xe(e,t);case"POST /documents/register-supporting":return we(e,t);default:return o(404,{error:"Route not found"})}};0&&(module.exports={handler});
