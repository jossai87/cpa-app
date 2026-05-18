"use strict";var q=Object.create;var P=Object.defineProperty;var M=Object.getOwnPropertyDescriptor;var _=Object.getOwnPropertyNames;var z=Object.getPrototypeOf,H=Object.prototype.hasOwnProperty;var Q=(e,t)=>{for(var n in t)P(e,n,{get:t[n],enumerable:!0})},j=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of _(t))!H.call(e,o)&&o!==n&&P(e,o,{get:()=>t[o],enumerable:!(r=M(t,o))||r.enumerable});return e};var R=(e,t,n)=>(n=e!=null?q(z(e)):{},j(t||!e||!e.__esModule?P(n,"default",{value:e,enumerable:!0}):n,e)),X=e=>j(P({},"__esModule",{value:!0}),e);var fe={};Q(fe,{handler:()=>pe});module.exports=X(fe);var p=require("@aws-sdk/client-s3"),$=require("@aws-sdk/s3-request-presigner"),E=require("@aws-sdk/client-bedrock-runtime"),G=require("@aws-sdk/client-dynamodb"),m=require("@aws-sdk/lib-dynamodb");var K=R(require("crypto")),C=new Uint8Array(256),T=C.length;function O(){return T>C.length-16&&(K.default.randomFillSync(C),T=0),C.slice(T,T+=16)}var l=[];for(let e=0;e<256;++e)l.push((e+256).toString(16).slice(1));function U(e,t=0){return l[e[t+0]]+l[e[t+1]]+l[e[t+2]]+l[e[t+3]]+"-"+l[e[t+4]]+l[e[t+5]]+"-"+l[e[t+6]]+l[e[t+7]]+"-"+l[e[t+8]]+l[e[t+9]]+"-"+l[e[t+10]]+l[e[t+11]]+l[e[t+12]]+l[e[t+13]]+l[e[t+14]]+l[e[t+15]]}var B=R(require("crypto")),F={randomUUID:B.default.randomUUID};function Z(e,t,n){if(F.randomUUID&&!t&&!e)return F.randomUUID();e=e||{};let r=e.random||(e.rng||O)();if(r[6]=r[6]&15|64,r[8]=r[8]&63|128,t){n=n||0;for(let o=0;o<16;++o)t[n+o]=r[o];return t}return U(r)}var S=Z;var k=new p.S3Client({region:"us-east-1"}),ee=new E.BedrockRuntimeClient({region:"us-east-1"}),te=new G.DynamoDBClient({region:"us-east-1"}),b=m.DynamoDBDocumentClient.from(te),N=process.env.DOCS_BUCKET??"",x=process.env.TABLE_NAME??"",ne=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var re=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/msword","image/png","image/jpeg"];function W(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"docx":return"application/vnd.openxmlformats-officedocument.wordprocessingml.document";case"doc":return"application/msword";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var oe=["auto","profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease","general"];async function ae(e,t){if(!e.body)return a(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!n.fileName)return a(400,{error:"fileName is required"});let r=W(n.fileName),o=n.contentType&&n.contentType!==""?n.contentType:r;if(!re.includes(o))return a(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let i=oe.includes(n.docType??"")?n.docType:"general",c=`${t}/${i}/${Date.now()}-${S()}-${n.fileName}`;try{let g=new p.PutObjectCommand({Bucket:N,Key:c}),u=await(0,$.getSignedUrl)(k,g,{expiresIn:300});return a(200,{uploadUrl:u,objectKey:c,docType:i,contentType:o,expiresIn:300})}catch(g){return console.error("Failed to create pre-signed URL:",g.message),a(500,{error:"Failed to create upload URL"})}}async function se(e,t){if(!e.body)return a(400,{error:"Request body is required"});let n;try{n=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!n.objectKey)return a(400,{error:"objectKey is required"});if(!n.objectKey.startsWith(`${t}/`))return a(403,{error:"Access denied to this document"});let r,o,i=null;try{let s=await k.send(new p.GetObjectCommand({Bucket:N,Key:n.objectKey}));if(o=s.ContentType??"application/octet-stream",o==="application/octet-stream"||o==="binary/octet-stream"){let d=W(n.objectKey);d!=="application/octet-stream"&&(o=d)}r=await s.Body.transformToByteArray(),(o==="text/csv"||o.startsWith("text/"))&&(i=new TextDecoder().decode(r),i.length>5e4&&(i=i.slice(0,5e4)+`

... [truncated]`))}catch(s){return console.error("Failed to read document from S3:",s.message),a(500,{error:"Failed to read uploaded document"})}function c(s){let d=[];if(o==="application/pdf")d.push({document:{format:"pdf",name:"uploaded-document",source:{bytes:Buffer.from(r).toString("base64")}}});else if(o==="image/png"||o==="image/jpeg"||o==="image/jpg"){let y=o==="image/png"?"png":"jpeg";d.push({image:{format:y,source:{bytes:Buffer.from(r).toString("base64")}}})}else o==="application/vnd.ms-excel"||o==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"?d.push({document:{format:"xlsx",name:"uploaded-document",source:{bytes:Buffer.from(r).toString("base64")}}}):(o==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"||o==="application/msword")&&d.push({document:{format:"docx",name:"uploaded-document",source:{bytes:Buffer.from(r).toString("base64")}}});return d.push({text:s}),d}async function g(s,d){let y={messages:[{role:"user",content:s}],inferenceConfig:{maxTokens:d,temperature:0}},h=new E.InvokeModelCommand({modelId:ne,contentType:"application/json",accept:"application/json",body:JSON.stringify(y)}),I=await ee.send(h);return JSON.parse(new TextDecoder().decode(I.body)).output.message.content[0].text}let u=n.docType??"auto",w=null;if(u==="auto")try{let s=ie(i),y=(await g(c(s),512)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim(),h=JSON.parse(y);w=h;let I=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","lease"];h.confidence==="low"||!I.includes(h.classifiedAs)?u="general":u=h.classifiedAs}catch(s){console.warn("Auto-classify failed, falling back to general:",s.message),u="general"}let Y=le(u,i),V=c(Y),A;try{let y=(await g(V,u==="bank-statement"||u==="line-of-credit"?4096:2048)).replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();A=JSON.parse(y)}catch(s){return console.error("Extraction failed:",s.message),a(502,{error:"Failed to extract data from document"})}let D=S(),v=new Date().toISOString(),L=n.fileName||n.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document",f=A,J=u==="bank-statement"||u==="line-of-credit"?f.categoryTotals??{}:Object.fromEntries(Object.entries(f).filter(([,s])=>typeof s=="number"&&s>0));try{await b.send(new m.PutCommand({TableName:x,Item:{userId:t,sk:`DOC#${v}#${D}`,docId:D,objectKey:n.objectKey,fileName:L,docType:u,contentType:o,uploadedAt:v,appliedTotals:J,flagged:f.flaggedTransactions??[],bankName:f.bankName??null,periodStart:f.periodStart??null,periodEnd:f.periodEnd??null,confidence:f.confidence??null,notes:f.notes??null,autoClassified:w!==null,autoClassifyResult:w??null}}))}catch(s){console.error("Failed to persist document record:",s.message)}return a(200,{docId:D,objectKey:n.objectKey,fileName:L,docType:u,contentType:o,uploadedAt:v,extracted:A,autoClassifyResult:w})}function ie(e){return`You are a CPA's document-intake assistant. Classify the attached business document into ONE of these categories:

- profit-loss          \u2192 P&L statement, income statement
- bank-statement       \u2192 business checking/savings monthly statement
- line-of-credit       \u2192 line of credit, business loan, or credit-card-style revolving statement
- payroll-summary      \u2192 payroll run, W-2 summary, 941 quarterly, payroll service annual report
- royalty-statement    \u2192 Foot Solutions corporate royalty/ad fund report
- sales-tax-return     \u2192 Texas sales tax return / WebFile confirmation
- fixed-assets         \u2192 depreciation schedule, fixed asset register
- insurance            \u2192 commercial insurance policy, declaration page, premium quote (general liability, workers comp, umbrella, etc.) \u2014 NOT health/life
- lease                \u2192 commercial lease agreement, rental contract
- general              \u2192 none of the above, or insufficient information

Return ONLY a JSON object with this exact shape (no markdown, no explanation):

{
  "classifiedAs": "<one of the categories above>",
  "confidence": "high|medium|low",
  "rationale": "<one short sentence \u2014 what made you pick this category>",
  "bestGuessLabel": "<a 2-4 word human-readable label for what this document appears to be, e.g. 'Lease Agreement' or 'Frost Bank Statement'>"
}

Use "low" confidence when you're unsure. Use "general" with the closest "bestGuessLabel" you can give if the document doesn't cleanly fit any specific category.${e?`
## Document Content (CSV)
\`\`\`
${e}
\`\`\``:""}`}function le(e,t){if(e==="bank-statement"||e==="line-of-credit")return ce(e,t);let n={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',lease:"Extract from this commercial lease document: rentLeasePayments (total ANNUAL base rent \u2014 multiply monthly rent \xD7 12 if needed), and provide additional metadata in `notes`: lease term in months, lease start/end dates, security deposit amount, monthly rent, any annual rent escalation percentage, CAM/triple-net charges if separate, and whether the rent includes utilities or property tax. If multiple rent figures are listed (e.g., escalating year by year), use the rent that applies for tax year "+new Date().getFullYear()+". Do NOT include the security deposit or one-time fees in rentLeasePayments.",general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},r=n[e]??n.general,o=t?`
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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function ce(e,t){let n=e==="line-of-credit",r=t?`
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

Respond with ONLY the JSON object.${r}`}async function ue(e){try{let n=((await b.send(new m.QueryCommand({TableName:x,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(r=>({docId:r.docId,fileName:r.fileName,docType:r.docType,objectKey:r.objectKey,contentType:r.contentType,uploadedAt:r.uploadedAt,appliedTotals:r.appliedTotals??{},flagged:r.flagged??[],bankName:r.bankName??null,periodStart:r.periodStart??null,periodEnd:r.periodEnd??null,confidence:r.confidence??null,notes:r.notes??null,autoClassified:r.autoClassified??!1,autoClassifyResult:r.autoClassifyResult??null}));return a(200,{documents:n})}catch(t){return console.error("Failed to list documents:",t.message),a(500,{error:"Failed to list documents"})}}async function de(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Document id is required"});let r;try{r=(await b.send(new m.QueryCommand({TableName:x,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":n},Limit:1}))).Items?.[0]}catch(i){return console.error("Failed to look up document:",i.message),a(500,{error:"Failed to look up document"})}if(!r)return a(404,{error:"Document not found"});let o=r.objectKey;if(!o.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{let i=new p.GetObjectCommand({Bucket:N,Key:o}),c=await(0,$.getSignedUrl)(k,i,{expiresIn:300});return a(200,{downloadUrl:c,fileName:r.fileName,expiresIn:300})}catch(i){return console.error("Failed to create download URL:",i.message),a(500,{error:"Failed to create download URL"})}}async function me(e,t){let n=e.pathParameters?.id;if(!n)return a(400,{error:"Document id is required"});let r;try{r=(await b.send(new m.QueryCommand({TableName:x,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":n},Limit:1}))).Items?.[0]}catch(c){return console.error("Failed to look up document for delete:",c.message),a(500,{error:"Failed to delete document"})}if(!r)return a(404,{error:"Document not found"});let o=r.sk,i=r.objectKey;if(!i.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{await k.send(new p.DeleteObjectCommand({Bucket:N,Key:i}))}catch(c){console.error("Failed to delete S3 object:",c.message)}try{await b.send(new m.DeleteCommand({TableName:x,Key:{userId:t,sk:o}}))}catch(c){return console.error("Failed to delete metadata record:",c.message),a(500,{error:"Failed to delete document metadata"})}return a(200,{docId:n,appliedTotals:r.appliedTotals??{},deleted:!0})}var pe=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return ae(e,t);case"POST /documents/extract":return se(e,t);case"POST /documents/bda-job":return a(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return ue(t);case"GET /documents/{id}/download-url":return de(e,t);case"DELETE /documents/{id}":return me(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
