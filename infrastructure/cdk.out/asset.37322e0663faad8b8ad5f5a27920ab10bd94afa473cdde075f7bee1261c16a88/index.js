"use strict";var C=Object.create;var m=Object.defineProperty;var R=Object.getOwnPropertyDescriptor;var E=Object.getOwnPropertyNames;var $=Object.getPrototypeOf,O=Object.prototype.hasOwnProperty;var F=(e,t)=>{for(var r in t)m(e,r,{get:t[r],enumerable:!0})},v=(e,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of E(t))!O.call(e,o)&&o!==r&&m(e,o,{get:()=>t[o],enumerable:!(n=R(t,o))||n.enumerable});return e};var D=(e,t,r)=>(r=e!=null?C($(e)):{},v(t||!e||!e.__esModule?m(r,"default",{value:e,enumerable:!0}):r,e)),L=e=>v(m({},"__esModule",{value:!0}),e);var z={};F(z,{handler:()=>J});module.exports=L(z);var x=require("@aws-sdk/client-bedrock-runtime"),A=require("@aws-sdk/client-dynamodb"),i=require("@aws-sdk/lib-dynamodb");var P=D(require("crypto")),p=new Uint8Array(256),y=p.length;function g(){return y>p.length-16&&(P.default.randomFillSync(p),y=0),p.slice(y,y+=16)}var a=[];for(let e=0;e<256;++e)a.push((e+256).toString(16).slice(1));function w(e,t=0){return a[e[t+0]]+a[e[t+1]]+a[e[t+2]]+a[e[t+3]]+"-"+a[e[t+4]]+a[e[t+5]]+"-"+a[e[t+6]]+a[e[t+7]]+"-"+a[e[t+8]]+a[e[t+9]]+"-"+a[e[t+10]]+a[e[t+11]]+a[e[t+12]]+a[e[t+13]]+a[e[t+14]]+a[e[t+15]]}var I=D(require("crypto")),h={randomUUID:I.default.randomUUID};function _(e,t,r){if(h.randomUUID&&!t&&!e)return h.randomUUID();e=e||{};let n=e.random||(e.rng||g)();if(n[6]=n[6]&15|64,n[8]=n[8]&63|128,t){r=r||0;for(let o=0;o<16;++o)t[r+o]=n[o];return t}return w(n)}var T=_;var q=new Set(["ssn","ein","password"]);function l(e){return e==null||typeof e!="object"?e:Array.isArray(e)?e.map(r=>l(r)):Object.fromEntries(Object.entries(e).map(([r,n])=>q.has(r.toLowerCase())?[r,"[REDACTED]"]:[r,l(n)]))}var B=new A.DynamoDBClient({region:"us-east-1"}),S=i.DynamoDBDocumentClient.from(B),k=new x.BedrockRuntimeClient({region:"us-east-1"}),b=process.env.TABLE_NAME,N=process.env.BEDROCK_MODEL_ID??"amazon.nova-2-lite-v1:0";function s(e,t){return{statusCode:e,headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}}function Y(e){let t=e.vehicleMilesDriven*.7,r=Math.min(e.homeOfficeSqFt,300)*5,n=e.totalRevenue-e.cogs-e.totalOperatingExpenses-e.royaltyFees-e.adFundContributions-e.leasePayments-e.section179Purchases,o=Math.max(0,n*.2);return`You are a CPA tax analysis assistant specializing in Texas franchise businesses.

Analyze the following financial data for a ${e.entityType} operating in Denton County, Texas for tax year ${e.taxYear}.

## Financial Data
- Total Annual Revenue: $${e.totalRevenue.toLocaleString()}
- Cost of Goods Sold (COGS): $${e.cogs.toLocaleString()}
- Total Compensation Paid: $${e.totalCompensation.toLocaleString()}
- Total Operating Expenses: $${e.totalOperatingExpenses.toLocaleString()}
- Royalty Fees Paid: $${e.royaltyFees.toLocaleString()}
- Advertising Fund Contributions: $${e.adFundContributions.toLocaleString()}
- Lease/Rent Payments: $${e.leasePayments.toLocaleString()}
- Section 179 Equipment Purchases: $${e.section179Purchases.toLocaleString()}
- Business Vehicle Miles Driven: ${e.vehicleMilesDriven.toLocaleString()}
- Home Office Square Footage: ${e.homeOfficeSqFt}
- Owner Health Insurance Premiums: $${e.ownerHealthInsurance.toLocaleString()}
- Standards Applied: ${e.useStandards?"Yes":"No"}

## Applied Standard Rates (if standards enabled)
${e.useStandards?`- IRS Mileage Rate: $0.70/mile \u2192 Deduction: $${t.toLocaleString()}
- Section 179 Limit: $1,160,000
- QBI Deduction (20% of qualified income): ~$${o.toLocaleString()}
- Home Office Rate: $5/sqft (max 300 sqft) \u2192 Deduction: $${r.toLocaleString()}
- Denton County Sales Tax Rate: 8.25% (TX 6.25% + City of Denton 1.5% + DCTA 0.5%)
- Texas Franchise Tax Rate: 0.375%`:"Not applied \u2014 user entered values manually."}

## Texas Tax Context
- Texas Franchise Tax no-tax-due threshold: $2,470,000 annualized revenue
- Four Texas margin methods: (1) revenue minus COGS, (2) revenue minus compensation, (3) 70% of revenue, (4) revenue minus $1M
- Use the method that results in the lowest tax liability
- Texas franchise tax rate: 0.375% on the margin

## Federal Deduction Rules
- Royalty fees: fully deductible as ordinary business expense
- Advertising fund contributions: fully deductible
- Lease/rent payments: fully deductible
- Section 179: immediate expensing up to $1,160,000 for eligible equipment
- QBI Deduction: up to 20% of qualified business income for pass-through entities (LLC, S-Corp, Sole Proprietorship, Partnership)
- Franchise fee amortization: amortize over 15 years (Section 197 intangible)
- Owner health insurance: deductible for self-employed individuals

## Required Output Format
Respond ONLY with a valid JSON object matching this exact structure (no markdown, no explanation):
{
  "estimatedFederalTaxableIncome": <number>,
  "estimatedFederalTaxLiability": <number>,
  "estimatedTexasFranchiseTax": <number>,
  "texasMarginMethodUsed": "<revenue_minus_cogs|revenue_minus_compensation|70_percent_revenue|revenue_minus_1m>",
  "estimatedSalesTaxOwed": <number>,
  "keyDeductions": ["<deduction 1>", "<deduction 2>", ...],
  "flaggedForCPAReview": ["<item 1>", ...],
  "ownerSummary": "<plain English 2-3 sentence summary>",
  "disclaimer": "This is an estimate only based on the figures provided. Actual tax liability may differ. Consult a licensed CPA before filing."
}`}async function M(e){let t={messages:[{role:"user",content:[{text:e}]}],inferenceConfig:{maxTokens:2048,temperature:.1}},r=new x.InvokeModelCommand({modelId:N,contentType:"application/json",accept:"application/json",body:JSON.stringify(t)}),n=await Promise.race([k.send(r),new Promise((u,c)=>setTimeout(()=>c(new Error("BEDROCK_TIMEOUT")),29e3))]),f=JSON.parse(new TextDecoder().decode(n.body)).output.message.content[0].text.replace(/^```json\s*/i,"").replace(/\s*```$/,"").trim();return JSON.parse(f)}async function G(e,t){if(!e.body)return s(400,{error:"Request body is required"});let r;try{r=JSON.parse(e.body)}catch{return s(400,{error:"Invalid JSON in request body"})}if(!r.taxYear||r.taxYear<2e3||r.taxYear>2099)return s(400,{error:"taxYear must be a 4-digit year between 2000 and 2099",field:"taxYear"});if(r.totalRevenue===void 0||r.totalRevenue<0)return s(400,{error:"totalRevenue is required and must be non-negative",field:"totalRevenue"});if(r.cogs===void 0||r.cogs<0)return s(400,{error:"cogs is required and must be non-negative",field:"cogs"});if(!r.entityType)return s(400,{error:"entityType is required",field:"entityType"});console.log("Tax calculation request:",JSON.stringify(l(r)));let n=T(),o=new Date().toISOString(),d;try{let u=Y(r);d=await M(u)}catch(u){let c=u;return c.message==="BEDROCK_TIMEOUT"?(console.error("Bedrock invocation timed out"),s(504,{error:"Tax analysis timed out. Please try again."})):(console.error("Bedrock invocation failed:",c.message),s(502,{error:"AI model returned an unexpected response. Please try again."}))}let f={userId:t,sk:`TAX#${n}`,sessionId:n,taxYear:r.taxYear,entityType:r.entityType,inputData:l(r),useStandards:r.useStandards,bedrockResponse:d,createdAt:o,status:"complete"};try{await S.send(new i.PutCommand({TableName:b,Item:f}))}catch(u){return console.error("DynamoDB write failed:",u.message),s(500,{error:"Failed to save tax session. Please try again."})}return s(200,{sessionId:n,taxYear:r.taxYear,createdAt:o,result:d})}async function U(e){try{let r=((await S.send(new i.QueryCommand({TableName:b,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":e,":prefix":"TAX#"},ScanIndexForward:!1,Limit:100,ProjectionExpression:"sessionId, taxYear, entityType, createdAt, #s",ExpressionAttributeNames:{"#s":"status"}}))).Items??[]).map(n=>({sessionId:n.sessionId,taxYear:n.taxYear,entityType:n.entityType,createdAt:n.createdAt,status:n.status}));return s(200,{sessions:r})}catch(t){return console.error("DynamoDB query failed:",t.message),s(500,{error:"Failed to retrieve tax history."})}}async function V(e,t){let r=e.pathParameters?.id;if(!r)return s(400,{error:"Session ID is required"});try{let n=await S.send(new i.GetCommand({TableName:b,Key:{userId:t,sk:`TAX#${r}`}}));if(!n.Item)return s(404,{error:"Session not found"});let o=n.Item;return s(200,{sessionId:o.sessionId,taxYear:o.taxYear,entityType:o.entityType,createdAt:o.createdAt,status:o.status,useStandards:o.useStandards,inputData:o.inputData,result:o.bedrockResponse})}catch(n){return console.error("DynamoDB get failed:",n.message),s(500,{error:"Failed to retrieve tax session."})}}var J=async e=>{let t=e.requestContext.authorizer.jwt.claims.sub;switch(e.routeKey){case"POST /tax/calculate":return G(e,t);case"GET /tax/history":return U(t);case"GET /tax/history/{id}":return V(e,t);default:return s(404,{error:"Route not found"})}};0&&(module.exports={handler});
