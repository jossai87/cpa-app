"use strict";var X=Object.create;var E=Object.defineProperty;var Q=Object.getOwnPropertyDescriptor;var Z=Object.getOwnPropertyNames;var ee=Object.getPrototypeOf,te=Object.prototype.hasOwnProperty;var ne=(e,t)=>{for(var r in t)E(e,r,{get:t[r],enumerable:!0})},Y=(e,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of Z(t))!te.call(e,o)&&o!==r&&E(e,o,{get:()=>t[o],enumerable:!(n=Q(t,o))||n.enumerable});return e};var B=(e,t,r)=>(r=e!=null?X(ee(e)):{},Y(t||!e||!e.__esModule?E(r,"default",{value:e,enumerable:!0}):r,e)),re=e=>Y(E({},"__esModule",{value:!0}),e);var be={};ne(be,{handler:()=>xe});module.exports=re(be);var g=require("@aws-sdk/client-s3"),j=require("@aws-sdk/s3-request-presigner"),A=require("@aws-sdk/client-bedrock-runtime"),V=require("@aws-sdk/client-dynamodb"),y=require("@aws-sdk/lib-dynamodb");var K=B(require("crypto")),I=new Uint8Array(256),D=I.length;function R(){return D>I.length-16&&(K.default.randomFillSync(I),D=0),I.slice(D,D+=16)}var u=[];for(let e=0;e<256;++e)u.push((e+256).toString(16).slice(1));function M(e,t=0){return u[e[t+0]]+u[e[t+1]]+u[e[t+2]]+u[e[t+3]]+"-"+u[e[t+4]]+u[e[t+5]]+"-"+u[e[t+6]]+u[e[t+7]]+"-"+u[e[t+8]]+u[e[t+9]]+"-"+u[e[t+10]]+u[e[t+11]]+u[e[t+12]]+u[e[t+13]]+u[e[t+14]]+u[e[t+15]]}var G=B(require("crypto")),$={randomUUID:G.default.randomUUID};function oe(e,t,r){if($.randomUUID&&!t&&!e)return $.randomUUID();e=e||{};let n=e.random||(e.rng||R)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){r=r||0;for(let o=0;o<16;++o)t[r+o]=n[o];return t}return M(n)}var k=oe;var S=new g.S3Client({region:"us-east-1"}),ae=new A.BedrockRuntimeClient({region:"us-east-1"}),se=new V.DynamoDBClient({region:"us-east-1"}),b=y.DynamoDBDocumentClient.from(se),O=process.env.DOCS_BUCKET??"",w=process.env.TABLE_NAME??"",ie=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0",W=process.env.BEDROCK_PRO_MODEL_ID??"us.amazon.nova-pro-v1:0";function _(e,t){return t||new Set(["lease","line-of-credit","bank-statement","profit-loss","general"]).has(e)?W:ie}function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var le=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function q(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var ce=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function ue(e,t){if(!e.body)return a(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!r.fileName)return a(400,{error:"fileName is required"});let n=q(r.fileName),o=r.contentType&&r.contentType!==""?r.contentType:n;if(!le.includes(o))return a(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let i=ce.includes(r.docType??"")?r.docType:"general",d=`${t}/${i}/${Date.now()}-${k()}-${r.fileName}`;try{let h=new g.PutObjectCommand({Bucket:O,Key:d}),m=await(0,j.getSignedUrl)(S,h,{expiresIn:300});return a(200,{uploadUrl:m,objectKey:d,docType:i,contentType:o,expiresIn:300})}catch(h){return console.error("Failed to create pre-signed URL:",h.message),a(500,{error:"Failed to create upload URL"})}}async function de(e,t){if(!e.body)return a(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!r.objectKey)return a(400,{error:"objectKey is required"});if(!r.objectKey.startsWith(`${t}/`))return a(403,{error:"Access denied to this document"});let n,o,i=null;try{let s=await S.send(new g.GetObjectCommand({Bucket:O,Key:r.objectKey}));if(o=s.ContentType??"application/octet-stream",o==="application/octet-stream"||o==="binary/octet-stream"){let l=q(r.objectKey);l!=="application/octet-stream"&&(o=l)}if(n=await s.Body.transformToByteArray(),n.byteLength>8*1024*1024)return a(413,{error:`Document is too large for AI extraction (${Math.round(n.byteLength/1024/1024)}MB). Files must be under 8MB. For large reference documents, store them outside this app.`});(o==="text/csv"||o.startsWith("text/"))&&(i=new TextDecoder().decode(n),i.length>5e4&&(i=i.slice(0,5e4)+`

... [truncated]`))}catch(s){return console.error("Failed to read document from S3:",s.message),a(500,{error:"Failed to read uploaded document"})}function d(s){let l=[],p="uploaded-document";if(o==="application/pdf")l.push({document:{format:"pdf",name:p,source:{bytes:n}}});else if(o==="image/png"||o==="image/jpeg"||o==="image/jpg"){let c=o==="image/png"?"png":"jpeg";l.push({image:{format:c,source:{bytes:n}}})}else o==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?l.push({document:{format:"xlsx",name:p,source:{bytes:n}}}):o==="application/vnd.ms-excel"?l.push({document:{format:"xls",name:p,source:{bytes:n}}}):o==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"?l.push({document:{format:"docx",name:p,source:{bytes:n}}}):o==="application/msword"&&l.push({document:{format:"doc",name:p,source:{bytes:n}}});return l.push({text:s}),l}async function h(s,l,p){let c=new A.ConverseCommand({modelId:p,messages:[{role:"user",content:s}],inferenceConfig:{maxTokens:l,temperature:0}}),P=(await Promise.race([ae.send(c),new Promise((Te,z)=>setTimeout(()=>z(new Error("BEDROCK_TIMEOUT")),25e3))])).output?.message?.content?.[0]?.text;if(!P)throw new Error("Bedrock returned no text content");return P}let m=r.docType??"auto",T=null,x=null;if(m==="auto")try{let s=me(i),p=(await h(d(s),4096,_("auto",!0))).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),c=JSON.parse(p);T={classifiedAs:c.classifiedAs,confidence:c.classifyConfidence,rationale:c.classifyRationale,...c.bestGuessLabel&&{bestGuessLabel:c.bestGuessLabel}};let L=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];c.classifyConfidence==="low"||!L.includes(c.classifiedAs)?m="general":m=c.classifiedAs,x=c.extracted??{}}catch(s){let l=s;if(l.message==="BEDROCK_TIMEOUT")return console.error("Bedrock auto-classify timed out"),a(504,{error:"AI processing timed out. This document may be too long or complex. Try a smaller file or pick the document type manually."});console.warn("Auto classify+extract failed, falling back to general:",l.message),m="general",x=null}if(x===null){let s=pe(m,i),l=d(s);try{let p=m==="bank-statement"||m==="line-of-credit",c=_(m,!1),P=(await h(l,p?4096:2048,c)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();x=JSON.parse(P)}catch(p){let c=p;return c.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock extraction timed out"),a(504,{error:"AI extraction timed out. This document may be too long. Try a smaller file or split it into pages."})):(console.error("Extraction failed:",c.message),a(502,{error:"Failed to extract data from document"}))}}let v=k(),F=new Date().toISOString(),U=r.fileName||r.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document";if(x===null)return a(502,{error:"Extraction returned no data"});let f=x,J=m==="bank-statement"||m==="line-of-credit",N=f.confidence==="low",H=N?{}:J?f.categoryTotals??{}:Object.fromEntries(Object.entries(f).filter(([,s])=>typeof s=="number"&&s>0));try{await b.send(new y.PutCommand({TableName:w,Item:{userId:t,sk:`DOC#${F}#${v}`,docId:v,objectKey:r.objectKey,fileName:U,docType:m,contentType:o,uploadedAt:F,appliedTotals:H,flagged:f.flaggedTransactions??[],bankName:f.bankName??null,periodStart:f.periodStart??null,periodEnd:f.periodEnd??null,confidence:f.confidence??null,notes:f.notes??null,autoClassified:T!==null,autoClassifyResult:T??null}}))}catch(s){console.error("Failed to persist document record:",s.message)}let C=f;return N&&(C=Object.fromEntries(Object.entries(f).filter(([,s])=>typeof s!="number")),C.confidence="low",C.notes=f.notes??"Low confidence \u2014 not auto-applied. Verify manually or pick a specific document type."),a(200,{docId:v,objectKey:r.objectKey,fileName:U,docType:m,contentType:o,uploadedAt:F,extracted:C,autoClassifyResult:T,isLowConfidence:N})}function me(e){return`You are a CPA's document-intake assistant for a Foot Solutions retail franchise in Denton County, Texas.

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
\`\`\``:""}`}function pe(e,t){if(e==="bank-statement"||e==="line-of-credit")return fe(e,t);let r={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',lease:"Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent \u2014 multiply monthly rent \xD7 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year "+new Date().getFullYear()+". Do NOT include the security deposit or one-time fees in rentLeasePayments.",general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},n=r[e]??r.general,o=t?`
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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function fe(e,t){let r=e==="line-of-credit",n=t?`
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

Respond with ONLY the JSON object.${n}`}async function ye(e){try{let r=((await b.send(new y.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(n=>({docId:n.docId,fileName:n.fileName,docType:n.docType,objectKey:n.objectKey,contentType:n.contentType,uploadedAt:n.uploadedAt,appliedTotals:n.appliedTotals??{},flagged:n.flagged??[],bankName:n.bankName??null,periodStart:n.periodStart??null,periodEnd:n.periodEnd??null,confidence:n.confidence??null,notes:n.notes??null,autoClassified:n.autoClassified??!1,autoClassifyResult:n.autoClassifyResult??null}));return a(200,{documents:r})}catch(t){return console.error("Failed to list documents:",t.message),a(500,{error:"Failed to list documents"})}}async function ge(e,t){let r=e.pathParameters?.id;if(!r)return a(400,{error:"Document id is required"});let n;try{n=(await b.send(new y.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(i){return console.error("Failed to look up document:",i.message),a(500,{error:"Failed to look up document"})}if(!n)return a(404,{error:"Document not found"});let o=n.objectKey;if(!o.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{let i=new g.GetObjectCommand({Bucket:O,Key:o}),d=await(0,j.getSignedUrl)(S,i,{expiresIn:300});return a(200,{downloadUrl:d,fileName:n.fileName,expiresIn:300})}catch(i){return console.error("Failed to create download URL:",i.message),a(500,{error:"Failed to create download URL"})}}async function he(e,t){let r=e.pathParameters?.id;if(!r)return a(400,{error:"Document id is required"});let n;try{n=(await b.send(new y.QueryCommand({TableName:w,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r}}))).Items?.[0]}catch(d){return console.error("Failed to look up document for delete:",d.message),a(500,{error:"Failed to delete document"})}if(!n)return a(404,{error:"Document not found"});let o=n.sk,i=n.objectKey;if(!i.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{await S.send(new g.DeleteObjectCommand({Bucket:O,Key:i}))}catch(d){console.error("Failed to delete S3 object:",d.message)}try{await b.send(new y.DeleteCommand({TableName:w,Key:{userId:t,sk:o}}))}catch(d){return console.error("Failed to delete metadata record:",d.message),a(500,{error:"Failed to delete document metadata"})}return a(200,{docId:r,appliedTotals:n.appliedTotals??{},deleted:!0})}var xe=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return ue(e,t);case"POST /documents/extract":return de(e,t);case"POST /documents/bda-job":return a(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return ye(t);case"GET /documents/{id}/download-url":return ge(e,t);case"DELETE /documents/{id}":return he(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
