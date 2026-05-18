"use strict";var V=Object.create;var x=Object.defineProperty;var Y=Object.getOwnPropertyDescriptor;var J=Object.getOwnPropertyNames;var q=Object.getPrototypeOf,_=Object.prototype.hasOwnProperty;var M=(e,t)=>{for(var r in t)x(e,r,{get:t[r],enumerable:!0})},v=(e,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of J(t))!_.call(e,o)&&o!==r&&x(e,o,{get:()=>t[o],enumerable:!(n=Y(t,o))||n.enumerable});return e};var F=(e,t,r)=>(r=e!=null?V(q(e)):{},v(t||!e||!e.__esModule?x(r,"default",{value:e,enumerable:!0}):r,e)),z=e=>v(x({},"__esModule",{value:!0}),e);var ue={};M(ue,{handler:()=>ce});module.exports=z(ue);var d=require("@aws-sdk/client-s3"),A=require("@aws-sdk/s3-request-presigner"),T=require("@aws-sdk/client-bedrock-runtime"),L=require("@aws-sdk/client-dynamodb"),u=require("@aws-sdk/lib-dynamodb");var $=F(require("crypto")),w=new Uint8Array(256),b=w.length;function k(){return b>w.length-16&&($.default.randomFillSync(w),b=0),w.slice(b,b+=16)}var l=[];for(let e=0;e<256;++e)l.push((e+256).toString(16).slice(1));function j(e,t=0){return l[e[t+0]]+l[e[t+1]]+l[e[t+2]]+l[e[t+3]]+"-"+l[e[t+4]]+l[e[t+5]]+"-"+l[e[t+6]]+l[e[t+7]]+"-"+l[e[t+8]]+l[e[t+9]]+"-"+l[e[t+10]]+l[e[t+11]]+l[e[t+12]]+l[e[t+13]]+l[e[t+14]]+l[e[t+15]]}var R=F(require("crypto")),N={randomUUID:R.default.randomUUID};function H(e,t,r){if(N.randomUUID&&!t&&!e)return N.randomUUID();e=e||{};let n=e.random||(e.rng||k)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){r=r||0;for(let o=0;o<16;++o)t[r+o]=n[o];return t}return j(n)}var P=H;var E=new d.S3Client({region:"us-east-1"}),Q=new T.BedrockRuntimeClient({region:"us-east-1"}),X=new L.DynamoDBClient({region:"us-east-1"}),f=u.DynamoDBDocumentClient.from(X),S=process.env.DOCS_BUCKET??"",g=process.env.TABLE_NAME??"",Z=process.env.BEDROCK_MODEL_ID??"us.amazon.nova-2-lite-v1:0";function a(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}var ee=["application/pdf","text/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","image/png","image/jpeg"];function K(e){switch(e.toLowerCase().split(".").pop()??""){case"pdf":return"application/pdf";case"csv":return"text/csv";case"xlsx":return"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";case"xls":return"application/vnd.ms-excel";case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";default:return"application/octet-stream"}}var te=["profit-loss","bank-statement","line-of-credit","payroll-summary","royalty-statement","sales-tax-return","fixed-assets","insurance","general"];async function re(e,t){if(!e.body)return a(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!r.fileName)return a(400,{error:"fileName is required"});let n=K(r.fileName),o=r.contentType&&r.contentType!==""?r.contentType:n;if(!ee.includes(o))return a(400,{error:"Unsupported file type. Allowed: PDF, CSV, XLSX, PNG, JPEG"});let i=te.includes(r.docType??"")?r.docType:"general",s=`${t}/${i}/${Date.now()}-${P()}-${r.fileName}`;try{let y=new d.PutObjectCommand({Bucket:S,Key:s}),p=await(0,A.getSignedUrl)(E,y,{expiresIn:300});return a(200,{uploadUrl:p,objectKey:s,docType:i,contentType:o,expiresIn:300})}catch(y){return console.error("Failed to create pre-signed URL:",y.message),a(500,{error:"Failed to create upload URL"})}}async function ne(e,t){if(!e.body)return a(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return a(400,{error:"Invalid JSON in request body"})}if(!r.objectKey)return a(400,{error:"objectKey is required"});if(!r.objectKey.startsWith(`${t}/`))return a(403,{error:"Access denied to this document"});let n,o,i=null;try{let c=await E.send(new d.GetObjectCommand({Bucket:S,Key:r.objectKey}));if(o=c.ContentType??"application/octet-stream",o==="application/octet-stream"||o==="binary/octet-stream"){let h=K(r.objectKey);h!=="application/octet-stream"&&(o=h)}n=await c.Body.transformToByteArray(),(o==="text/csv"||o.startsWith("text/"))&&(i=new TextDecoder().decode(n),i.length>5e4&&(i=i.slice(0,5e4)+`

... [truncated]`))}catch(c){return console.error("Failed to read document from S3:",c.message),a(500,{error:"Failed to read uploaded document"})}let s=r.docType??"general",y=oe(s,i),p=[];if(o==="application/pdf")p.push({document:{format:"pdf",name:"uploaded-document",source:{bytes:Buffer.from(n).toString("base64")}}});else if(o==="image/png"||o==="image/jpeg"||o==="image/jpg"){let c=o==="image/png"?"png":"jpeg";p.push({image:{format:c,source:{bytes:Buffer.from(n).toString("base64")}}})}else(o==="application/vnd.ms-excel"||o==="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")&&p.push({document:{format:"xlsx",name:"uploaded-document",source:{bytes:Buffer.from(n).toString("base64")}}});p.push({text:y});let C;try{let h={messages:[{role:"user",content:p}],inferenceConfig:{maxTokens:s==="bank-statement"||s==="line-of-credit"?4096:2048,temperature:0}},B=new T.InvokeModelCommand({modelId:Z,contentType:"application/json",accept:"application/json",body:JSON.stringify(h)}),W=await Q.send(B),G=JSON.parse(new TextDecoder().decode(W.body)).output.message.content[0].text.replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();C=JSON.parse(G)}catch(c){return console.error("Extraction failed:",c.message),a(502,{error:"Failed to extract data from document"})}let D=P(),I=new Date().toISOString(),O=r.fileName||r.objectKey.split("/").pop()?.replace(/^\d+-[0-9a-f-]+-/,"")||"document",m=C,U=s==="bank-statement"||s==="line-of-credit"?m.categoryTotals??{}:Object.fromEntries(Object.entries(m).filter(([,c])=>typeof c=="number"&&c>0));try{await f.send(new u.PutCommand({TableName:g,Item:{userId:t,sk:`DOC#${I}#${D}`,docId:D,objectKey:r.objectKey,fileName:O,docType:s,contentType:o,uploadedAt:I,appliedTotals:U,flagged:m.flaggedTransactions??[],bankName:m.bankName??null,periodStart:m.periodStart??null,periodEnd:m.periodEnd??null,confidence:m.confidence??null,notes:m.notes??null}}))}catch(c){console.error("Failed to persist document record:",c.message)}return a(200,{docId:D,objectKey:r.objectKey,fileName:O,docType:s,contentType:o,uploadedAt:I,extracted:C})}function oe(e,t){if(e==="bank-statement"||e==="line-of-credit")return ae(e,t);let r={"profit-loss":"Extract: totalRevenue, cogs, totalOperatingExpenses, netIncome, rentLeasePayments, utilities, businessInsurancePremiums, marketingAdvertising, professionalFees, totalEmployeeWages.","payroll-summary":"Extract: totalEmployeeWages, employerPayrollTaxes, employeeCount, retirementPlanContributions, employerHealthInsurance.","royalty-statement":"Extract: totalRevenue (gross sales reported), royaltyFees, adFundContributions.","sales-tax-return":"Extract: totalRevenue (taxable sales), salesTaxCollected, salesTaxRemitted.","fixed-assets":"Extract: totalEquipmentCost (sum of all assets purchased this year), and an array of individual assets with description, cost, placedInServiceDate, depreciationMethod.",insurance:'Extract: businessInsurancePremiums (total ANNUAL premium for general liability, commercial property, workers comp, umbrella, professional liability \u2014 sum if multiple policies). Do NOT include health, life, or disability premiums for the owner. Look for keywords like "annual premium", "total premium", "policy premium", "estimated premium".',general:"Extract any financial figures relevant to small business taxes: revenue, expenses, payroll, inventory, equipment, insurance premiums."},n=r[e]??r.general,o=t?`
## Document Content (CSV)
\`\`\`
${t}
\`\`\``:"";return`You are extracting structured tax data from a ${e} document for a Foot Solutions retail franchise in Denton County, Texas.

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

Respond with ONLY the JSON object \u2014 no markdown fences, no explanation.`}function ae(e,t){let r=e==="line-of-credit",n=t?`
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

Respond with ONLY the JSON object.${n}`}async function se(e){try{let r=((await f.send(new u.QueryCommand({TableName:g,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"DOC#"},ScanIndexForward:!1,Limit:200}))).Items??[]).map(n=>({docId:n.docId,fileName:n.fileName,docType:n.docType,objectKey:n.objectKey,contentType:n.contentType,uploadedAt:n.uploadedAt,appliedTotals:n.appliedTotals??{},flagged:n.flagged??[],bankName:n.bankName??null,periodStart:n.periodStart??null,periodEnd:n.periodEnd??null,confidence:n.confidence??null,notes:n.notes??null}));return a(200,{documents:r})}catch(t){return console.error("Failed to list documents:",t.message),a(500,{error:"Failed to list documents"})}}async function ie(e,t){let r=e.pathParameters?.id;if(!r)return a(400,{error:"Document id is required"});let n;try{n=(await f.send(new u.QueryCommand({TableName:g,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r},Limit:1}))).Items?.[0]}catch(i){return console.error("Failed to look up document:",i.message),a(500,{error:"Failed to look up document"})}if(!n)return a(404,{error:"Document not found"});let o=n.objectKey;if(!o.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{let i=new d.GetObjectCommand({Bucket:S,Key:o}),s=await(0,A.getSignedUrl)(E,i,{expiresIn:300});return a(200,{downloadUrl:s,fileName:n.fileName,expiresIn:300})}catch(i){return console.error("Failed to create download URL:",i.message),a(500,{error:"Failed to create download URL"})}}async function le(e,t){let r=e.pathParameters?.id;if(!r)return a(400,{error:"Document id is required"});let n;try{n=(await f.send(new u.QueryCommand({TableName:g,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",FilterExpression:"docId = :docId",ExpressionAttributeValues:{":uid":t,":prefix":"DOC#",":docId":r},Limit:1}))).Items?.[0]}catch(s){return console.error("Failed to look up document for delete:",s.message),a(500,{error:"Failed to delete document"})}if(!n)return a(404,{error:"Document not found"});let o=n.sk,i=n.objectKey;if(!i.startsWith(`${t}/`))return a(403,{error:"Access denied"});try{await E.send(new d.DeleteObjectCommand({Bucket:S,Key:i}))}catch(s){console.error("Failed to delete S3 object:",s.message)}try{await f.send(new u.DeleteCommand({TableName:g,Key:{userId:t,sk:o}}))}catch(s){return console.error("Failed to delete metadata record:",s.message),a(500,{error:"Failed to delete document metadata"})}return a(200,{docId:r,appliedTotals:n.appliedTotals??{},deleted:!0})}var ce=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /documents/upload-url":return re(e,t);case"POST /documents/extract":return ne(e,t);case"POST /documents/bda-job":return a(501,{error:"Not implemented in Phase 1 \u2014 use /documents/extract for CSV"});case"GET /documents":return se(t);case"GET /documents/{id}/download-url":return ie(e,t);case"DELETE /documents/{id}":return le(e,t);default:return a(404,{error:"Route not found"})}};0&&(module.exports={handler});
