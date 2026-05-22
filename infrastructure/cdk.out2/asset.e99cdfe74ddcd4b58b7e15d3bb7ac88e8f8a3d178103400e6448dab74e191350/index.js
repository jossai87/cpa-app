"use strict";var L=Object.defineProperty;var ie=Object.getOwnPropertyDescriptor;var ae=Object.getOwnPropertyNames;var ce=Object.prototype.hasOwnProperty;var de=(n,e)=>{for(var o in e)L(n,o,{get:e[o],enumerable:!0})},le=(n,e,o,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of ae(e))!ce.call(n,r)&&r!==o&&L(n,r,{get:()=>e[r],enumerable:!(t=ie(e,r))||t.enumerable});return n};var ue=n=>le(L({},"__esModule",{value:!0}),n);var Fe={};de(Fe,{handler:()=>$e});module.exports=ue(Fe);var re=require("@aws-sdk/client-dynamodb"),l=require("@aws-sdk/lib-dynamodb"),x=require("@aws-sdk/client-bedrock-runtime"),O=require("@aws-sdk/client-sesv2");var I=require("@aws-sdk/client-secrets-manager"),me="us-east-1",pe="foot-solutions/gmail/oauth-client",ge="foot-solutions/gmail/refresh-token",ye=new I.SecretsManagerClient({region:me}),E=null;async function V(n){let e=await ye.send(new I.GetSecretValueCommand({SecretId:n}));if(!e.SecretString)throw new Error(`Secret ${n} is empty`);return JSON.parse(e.SecretString)}async function he(){if(E&&E.expiresAt>Date.now()+6e4)return E.token;let[n,e]=await Promise.all([V(pe),V(ge)]),o=new URLSearchParams({client_id:n.client_id,client_secret:n.client_secret,refresh_token:e.refresh_token,grant_type:"refresh_token"}),t=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:o.toString()});if(!t.ok)throw new Error(`Failed to refresh access token: ${t.status} ${await t.text()}`);let r=await t.json();return E={token:r.access_token,expiresAt:Date.now()+r.expires_in*1e3},r.access_token}async function $(n){let e=await he(),o=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${n}`,{headers:{Authorization:`Bearer ${e}`}});if(!o.ok)throw new Error(`Gmail API ${n} failed: ${o.status} ${await o.text()}`);return await o.json()}async function F(n,e=20){let o=new URLSearchParams({q:n,maxResults:String(Math.min(e,50))});return(await $(`/messages?${o.toString()}`)).messages??[]}function B(n){let e=n.replace(/-/g,"+").replace(/_/g,"/");return Buffer.from(e,"base64").toString("utf-8")}function fe(n){if(!n)return"";function e(o){for(let t of o)if(t.mimeType==="text/plain"&&t.body?.data)return B(t.body.data);for(let t of o)if(t.parts){let r=e(t.parts);if(r)return r}for(let t of o)if(t.mimeType==="text/html"&&t.body?.data)return B(t.body.data).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();return null}if(n.parts){let o=e(n.parts);if(o)return o}if(n.body?.data){let o=B(n.body.data);return n.mimeType==="text/html"?o.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim():o}return""}async function z(n,e=4e3){let o=await $(`/messages/${n}?format=full`),t=o.payload?.headers??[],r=i=>t.find(c=>c.name.toLowerCase()===i.toLowerCase())?.value??"",s=fe(o.payload),a=s.length>e?s.slice(0,e):s;return{id:o.id,threadId:o.threadId,date:new Date(parseInt(o.internalDate,10)).toISOString(),from:r("From"),to:r("To"),subject:r("Subject"),snippet:o.snippet,body:a,truncated:s.length>e}}async function Q(n=14){let e=["brooks","dansko","aetrex","hoka","olukai","drew","finn","rockport","saucony","vionic","mephisto","feetures","apex","naot","yaleet"],o=["roland","janell"],r=`(${[...e,...o].map(i=>`"${i}"`).join(" OR ")}) newer_than:${n}d -category:promotions`,s=await F(r,30);if(s.length===0)return{query:r,count:0,threads:[]};let a=await Promise.all(s.slice(0,15).map(async i=>{let c=await $(`/messages/${i.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`),m=c.payload?.headers??[],u=S=>m.find(d=>d.name.toLowerCase()===S.toLowerCase())?.value??"";return{id:i.id,from:u("From"),subject:u("Subject"),date:new Date(parseInt(c.internalDate,10)).toISOString(),snippet:c.snippet}}));return{query:r,count:s.length,threads:a}}var X=require("@aws-sdk/client-dynamodb"),b=require("@aws-sdk/lib-dynamodb"),we=new X.DynamoDBClient({region:"us-east-1"}),G=b.DynamoDBDocumentClient.from(we),j=process.env.TABLE_NAME,U=process.env.OWNER_USER_ID;function be(n){return n.toLowerCase().replace(/[^a-z0-9]/g,"")}function Se(n,e,o){return!(e&&n<e||o&&n>o)}async function q(n){let e=Math.min(n.limit??25,100),o=n.since??"2000-01-01",t=n.until??"2999-12-31",r;n.vendor?r=`GMAIL#VENDOR#${be(n.vendor)}#`:n.threadId?r=`GMAIL#THREAD#${n.threadId}#`:n.kind?r=`GMAIL#KIND#${n.kind.toLowerCase()}#`:r="GMAIL#MSG#";let s=`${r}${o}`,a=`${r}${t}\uFFFF`,i,c=[];for(;c.length<e*4;){let d=await G.send(new b.QueryCommand({TableName:j,KeyConditionExpression:"userId = :uid AND sk BETWEEN :lo AND :hi",ExpressionAttributeValues:{":uid":U,":lo":s,":hi":a},ExclusiveStartKey:i,Limit:200}));for(let f of d.Items??[]){let h=f;if(n.text){let T=n.text.toLowerCase();if(!`${h.subject??""} ${h.snippet??""}`.toLowerCase().includes(T))continue}if(!(n.from&&!(h.from??"").toLowerCase().includes(n.from.toLowerCase()))&&Se(h.dateOnly,n.since,n.until)&&(c.push(h),c.length>=e*4))break}if(!d.LastEvaluatedKey)break;i=d.LastEvaluatedKey}let m=new Map;for(let d of c)m.has(d.id)||m.set(d.id,d);let u=[...m.values()].sort((d,f)=>(f.date??"").localeCompare(d.date??"")),S=u.slice(0,e);return{total:u.length,rows:S.map(d=>({id:d.id,threadId:d.threadId,date:d.date,dateOnly:d.dateOnly,from:d.from,to:d.to,subject:d.subject,snippet:d.snippet,vendorBrand:d.vendorBrand,kind:d.kind,hasAttachment:d.hasAttachment}))}}async function Z(n,e){if(e)return Te(n,e);let t=((await G.send(new b.QueryCommand({TableName:j,KeyConditionExpression:"userId = :uid AND begins_with(sk, :p)",FilterExpression:"#id = :id",ExpressionAttributeNames:{"#id":"id"},ExpressionAttributeValues:{":uid":U,":p":"GMAIL#MSG#",":id":n}}))).Items??[]).find(r=>r.id===n);return t||null}async function Te(n,e){return(await G.send(new b.GetCommand({TableName:j,Key:{userId:U,sk:`GMAIL#MSG#${e}#${n}`}}))).Item??null}async function ee(n,e=90){let o=new Date(Date.now()-e*86400*1e3).toISOString().slice(0,10),t=await q({vendor:n,since:o,limit:100}),r=new Map,s=new Map,a=null;for(let i of t.rows)i.from&&r.set(i.from,(r.get(i.from)??0)+1),i.subject&&s.set(i.subject,(s.get(i.subject)??0)+1),(!a||(i.date??"")>a)&&(a=i.date??null);return{vendor:n,messageCount:t.rows.length,lastContactDate:a,topSenders:[...r.entries()].sort((i,c)=>c[1]-i[1]).slice(0,5).map(([i,c])=>({from:i,count:c})),topSubjects:[...s.entries()].sort((i,c)=>c[1]-i[1]).slice(0,5).map(([i,c])=>({subject:i,count:c})),recentMessageIds:t.rows.slice(0,10).map(i=>i.id)}}var _=require("@aws-sdk/client-secrets-manager"),ve="us-east-1",H="foot-solutions/tavily/api-key",ke=new _.SecretsManagerClient({region:ve}),A=null;async function De(){if(A)return A;let n=await ke.send(new _.GetSecretValueCommand({SecretId:H}));if(!n.SecretString)throw new Error(`Secret ${H} is empty`);let e=JSON.parse(n.SecretString);if(!e.apiKey)throw new Error(`Secret ${H} missing apiKey`);return A=e.apiKey,A}async function te(n,e={}){let t={api_key:await De(),query:n,search_depth:e.searchDepth??"basic",max_results:Math.min(e.maxResults??5,20),include_answer:e.includeAnswer??!1};e.topic&&(t.topic=e.topic),e.days&&(t.days=e.days),e.includeDomains?.length&&(t.include_domains=e.includeDomains),e.excludeDomains?.length&&(t.exclude_domains=e.excludeDomains);let r=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)});if(!r.ok){let s=await r.text();throw new Error(`Tavily ${r.status}: ${s.slice(0,200)}`)}return await r.json()}var Ee=new re.DynamoDBClient({region:"us-east-1"}),p=l.DynamoDBDocumentClient.from(Ee),Ie=new x.BedrockRuntimeClient({region:"us-east-1"}),Ae=new O.SESv2Client({region:"us-east-1"}),g=process.env.TABLE_NAME,y=process.env.OWNER_USER_ID,_e=process.env.BEDROCK_MODEL_ID??"global.anthropic.claude-sonnet-4-5-20250929-v1:0",ne=process.env.FROM_ADDRESS??"noreply@fsmanagementsystem.com",D=process.env.TO_ADDRESS??"flowermound@footsolutions.com",se="America/Chicago",xe=new Set([0,1]);function oe(n=new Date){return new Intl.DateTimeFormat("en-CA",{timeZone:se,year:"numeric",month:"2-digit",day:"2-digit"}).format(n)}function K(){return oe()}function Oe(n=new Date){let e=new Intl.DateTimeFormat("en-US",{timeZone:se,weekday:"short"}).format(n);return{Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[e]??new Date().getDay()}function Re(n){let e=new Date;return e.setUTCDate(e.getUTCDate()-n),oe(e)}function w(n){return Math.round(n*100)/100}var Ce=`
=== STORE & MARKET CONTEXT ===
Store: Foot Solutions Flower Mound \u2014 2701 Cross Timbers Rd area, Flower Mound TX 75028
Status: Recently acquired by new owner. Currently in declining sales state. Goal: 7-9\xD7 growth in 12 months.
Specialty: Custom orthotics ($400-500), orthopedic shoes, accessories, gait analysis.
Hours: Open Tue\u2013Sat. Closed Sun & Mon (do NOT suggest events on Sun or Mon).

=== DENTON COUNTY DEMOGRAPHICS ===
- Population: 906,422 (2020 census), 7th most populous county in TX, fast-growing
- Senior population (65+) is one of fastest-growing demographic groups
- Adjacent: Lewisville, Highland Village, Argyle, Denton, Coppell, Grapevine
- High household incomes, strong disposable spending power

=== KEY VENUES (verified addresses + phones) ===

1. Flower Mound Senior Center
   Address: 2701 W Windsor Dr, Flower Mound TX 75028
   Phone: 972-874-6110 (courtesy desk + general info)
   Email: director@flseniorcenter.org
   Programs: "Seniors In Motion" daily fitness/dance/art classes, lunches, games.
   $10/yr resident, $20/yr non-resident.
   \u2192 Best fit: monthly demo days, fall-prevention seminars, fitting clinics.

2. Texas Health Presbyterian Hospital Flower Mound
   Address: 4400 Long Prairie Rd, Flower Mound TX 75028
   Volunteer/Community Outreach: call main 972-887-2900, ask for Volunteer Services
   Texas Health Resources general volunteer line: 1-866-411-9358
   \u2192 Best fit: nurse/staff bulk fittings, Wellness Wednesday partnerships.
   Designated Bariatric Surgery Center of Excellence \u2014 bariatric patients are
   prime orthopedic candidates due to weight-related foot issues.

3. Texas Health Presbyterian Hospital Denton
   Address: 3000 N I-35, Denton TX 76201
   Diabetes & wound care center \u2014 high-value referrals for diabetic shoes.

4. Medical City Lewisville
   Address: 500 W Main St, Lewisville TX 75057
   Phone: 972-420-1000

5. Flower Mound Chamber of Commerce
   Phone: 972-539-0500
   Web: flowermoundchamber.com
   \u2192 Best fit: networking mixers, ribbon cuttings, B2B introductions.

6. Flower Mound Public Library
   Address: 3030 Broadmoor Ln, Flower Mound TX 75028
   Phone: 972-874-6200
   \u2192 Best fit: free community event venue, foot health seminars.

7. Flower Mound Women in Business (FMWIB)
   Contact: Amanda Bennett
   Phone: 612-220-1378
   Address: 2221 Justin Rd Suite 119-101, Flower Mound TX 75028
   \u2192 Best fit: women's networking \u2014 high-margin customer demographic.

8. Flower Mound Pharmacy & Herbal Alternatives
   Contact: Dennis W. Song, RPh
   Phone: 972-355-4614
   Address: 1001 Cross Timbers Rd, Suite 1170, Flower Mound TX 75028
   \u2192 Best fit: cross-referral partner. Diabetics filling prescriptions need
   diabetic shoes. Just down the road from the store.

9. Flower Mound Presbyterian Church
   Address: 1501 Flower Mound Road, Flower Mound TX 75028
   Phone: 972-539-7184
   \u2192 Best fit: senior fellowship groups, health fair sponsorships.

10. Lewisville ISD (LISD) high schools \u2014 Flower Mound HS, Marcus HS
    Phone: 469-713-5192 (Flower Mound HS)
    \u2192 Best fit: athletic departments (coaches stand all day), wellness fairs.

11. UNT (University of North Texas), Denton
    Address: 1155 Union Cir, Denton TX 76203
    \u2192 Best fit: faculty, athletic programs, runner clubs (Brooks/Hoka).

=== TARGET MARKET PILLARS (high-value customer segments) ===
1. Hospitals/clinics: nurses, doctors, techs on 12-hour shifts
2. Restaurants: servers, line cooks, bartenders (Highland Village restaurant district)
3. Schools: teachers, coaches, school nurses (LISD, Argyle ISD)
4. Senior centers + senior living facilities
5. Churches with elderly congregations
6. Manufacturing/warehouse: Amazon DFT5/DFT6, FedEx in Lewisville/Coppell
7. Podiatrists: highest-margin recurring referrals (custom orthotics)

=== RECURRING LOCAL EVENTS (typical patterns) ===
- Flower Mound Senior Center Health Fair (annual fall)
- Senior Center monthly bingo + craft fairs (Tuesdays/Thursdays typical)
- Flower Mound Farmers Market (Saturdays seasonal, Town Hall Plaza)
- Heritage Days (Sept) \u2014 town festival
- Memorial Day Ceremony (May, Flower Mound)
- Denton Arts & Jazz Festival (April)
- DFW Senior Expos \u2014 multiple per year, sponsor opportunity
- Chamber Awards & networking mixers (monthly)

=== PRODUCT / MARGIN INTELLIGENCE ===
Custom orthotics: $400-500 retail, highest margin in store
Brooks/Hoka: athletic running, mid-margin, fast-mover, attracts younger customers
Aetrex: orthopedic comfort, ~50% margin, senior favorite
Dansko/Sanita: clogs, restaurant/medical staff favorite
Drew/PW Minor: extra-wide diabetic footwear, hospital referral driven
Brand-new accessories: high-margin, low-friction add-on at checkout

=== STRATEGIC PILLARS ===
1. INVENTORY VELOCITY \u2014 turn slow-movers into cash via markdowns
2. EVENT-BASED MARKETING \u2014 be where the foot pain is
3. B2B PARTNERSHIPS \u2014 bulk staff fittings at hospitals/schools/restaurants
4. PODIATRIST REFERRALS \u2014 recurring high-margin custom orthotic pipeline
5. LOCAL VISIBILITY \u2014 Google Business Profile, reviews, sponsorships
`,Ne=[{toolSpec:{name:"get_sales_for_date",description:"Get revenue, ticket count, discounts, top sales rep for a specific date. Use to compare today vs yesterday, vs same day last year, etc.",inputSchema:{json:{type:"object",properties:{date:{type:"string",description:"YYYY-MM-DD in Central Time"}},required:["date"]}}}},{toolSpec:{name:"get_top_brands_today",description:"Get the brands that sold today with margins, useful for spotting which brand to push or markdown.",inputSchema:{json:{type:"object",properties:{limit:{type:"number",description:"Top N brands (default 5)"}},required:[]}}}},{toolSpec:{name:"get_low_stock_urgent",description:"Get items at 1 or fewer units on hand \u2014 these need immediate reorder or could be lost sales.",inputSchema:{json:{type:"object",properties:{limit:{type:"number",description:"Top N items (default 10)"}},required:[]}}}},{toolSpec:{name:"get_recent_trend",description:"Get sales trend for the last N days to detect momentum (gaining/declining/flat).",inputSchema:{json:{type:"object",properties:{days:{type:"number",description:"Number of days (default 7)"}},required:[]}}}},{toolSpec:{name:"get_pending_opportunities",description:"Read the opportunity ledger \u2014 strategic items the AI is tracking across emails (events to attend, leads to follow up, low-stock to reorder, partnership pitches in progress, etc.). Returns each item with its priority, status, mention count, and last-mentioned date so you can decide whether to surface it again.",inputSchema:{json:{type:"object",properties:{},required:[]}}}},{toolSpec:{name:"record_opportunity",description:"Add a new strategic opportunity to the ledger. Use this when you discover something worth tracking across multiple emails \u2014 like an upcoming event, a brand at urgent low-stock, a partnership lead, etc. The owner sees this in upcoming briefings.",inputSchema:{json:{type:"object",properties:{id:{type:"string",description:"Stable kebab-case ID (e.g. senior-center-bingo-may-25). Use the same ID across days for the same opportunity."},title:{type:"string",description:'Short title (e.g. "Senior Center bingo demo opportunity")'},category:{type:"string",enum:["event","reorder","partnership","inventory","staff","other"],description:"Type of opportunity"},priority:{type:"number",description:"Importance 1-10 (10 = must mention every day until done, 5 = mention every 2-3 days, 2 = mention once)"},details:{type:"string",description:"Full context: who/where/when/contact phone"},dueDate:{type:"string",description:"YYYY-MM-DD if time-sensitive (e.g. event date)"}},required:["id","title","category","priority","details"]}}}},{toolSpec:{name:"update_opportunity",description:"Mark an opportunity as mentioned in today's email (so we can space repeats by priority) OR update its details/priority based on new information.",inputSchema:{json:{type:"object",properties:{id:{type:"string",description:"The opportunity ID"},mentionedToday:{type:"boolean",description:"Set true if this was included in today's email"},priority:{type:"number",description:"New priority 1-10 (optional)"},details:{type:"string",description:"Updated details (optional)"},dueDate:{type:"string",description:"Updated due date YYYY-MM-DD (optional)"}},required:["id"]}}}},{toolSpec:{name:"mark_opportunity_done",description:"Remove an opportunity from the active ledger when it's been completed, attended, or expired. Past events should be marked done the day after.",inputSchema:{json:{type:"object",properties:{id:{type:"string",description:"The opportunity ID"},outcome:{type:"string",description:'Brief outcome note (e.g. "attended, 3 leads")'}},required:["id"]}}}},{toolSpec:{name:"scan_recent_vendor_emails",description:"Quickly scan the last 14 days of inbox for vendor brand mentions (Brooks, Dansko, Aetrex, etc.) plus key people (Roland, Janell). Returns up to 15 thread summaries with sender, subject, date, and snippet. Use this to surface vendor follow-ups, event invitations, or relationship context the owner might have missed.",inputSchema:{json:{type:"object",properties:{days:{type:"number",description:"How many days back to scan (default 14, max 30)"}},required:[]}}}},{toolSpec:{name:"search_inbox",description:'Search the inbox using Gmail query syntax (e.g. "from:brooksrunning.com newer_than:7d", "subject:invoice", "from:roland"). Returns matching message IDs you can pass to read_email.',inputSchema:{json:{type:"object",properties:{query:{type:"string",description:"Gmail search query \u2014 supports from:, to:, subject:, has:attachment, newer_than:Nd, etc."},max:{type:"number",description:"Max results (default 10, hard cap 30)"}},required:["query"]}}}},{toolSpec:{name:"read_email",description:"Fetch the full headers + plaintext body of one email by ID (from search_inbox or scan_recent_vendor_emails). Use this when you need the actual content \u2014 pricing, dates, names \u2014 not just the snippet.",inputSchema:{json:{type:"object",properties:{id:{type:"string",description:"Gmail message ID"}},required:["id"]}}}},{toolSpec:{name:"cache_query",description:"Query the local Gmail cache (rolling ~6 month window). Use kind=corporate / franchise / vendor / customer / invoice with since/until to scope. Faster than live Gmail. Use this BEFORE search_inbox.",inputSchema:{json:{type:"object",properties:{vendor:{type:"string",description:"Vendor brand (Brooks, Dansko, etc.)"},kind:{type:"string",enum:["invoice","vendor","customer","corporate","franchise","internal"]},since:{type:"string",description:"YYYY-MM-DD inclusive"},until:{type:"string",description:"YYYY-MM-DD inclusive"},from:{type:"string",description:"From-header substring"},text:{type:"string",description:"Subject/snippet substring"},limit:{type:"number",description:"Default 25, max 100"}},required:[]}}}},{toolSpec:{name:"cache_vendor_activity",description:"Quickly summarize a vendor's email activity over the last N days: message count, last contact date, top senders, top subjects. Use to answer 'how active is Brooks' or 'when did Aetrex last reach out'.",inputSchema:{json:{type:"object",properties:{vendor:{type:"string"},days:{type:"number",description:"Default 90, max 365"}},required:["vendor"]}}}},{toolSpec:{name:"cache_read",description:"Read full body of a cached email. Provide dateOnly for fastest path.",inputSchema:{json:{type:"object",properties:{id:{type:"string"},dateOnly:{type:"string"}},required:["id"]}}}},{toolSpec:{name:"web_search",description:"Tavily news search. Use SPARINGLY (max 2 calls per email) to verify a vendor announcement or local event before recommending it. Examples: 'Foot Solutions corporate news 2026', 'Brooks running launch this week', 'Flower Mound Senior Center events May 2026'.",inputSchema:{json:{type:"object",properties:{query:{type:"string"},days:{type:"number",description:"Last N days (default 7)."},maxResults:{type:"number"}},required:["query"]}}}}];async function Me(n,e){let o=K();switch(n){case"get_sales_for_date":{let t=e.date||o,s=(await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:`POS#DAILY#${t}`}}))).Item?.rollup;if(!s)return JSON.stringify({date:t,hasData:!1});let a=Object.entries(s.bySalesRep??{}).sort((i,c)=>c[1]-i[1])[0];return JSON.stringify({date:t,hasData:!0,revenue:w(s.totalAmount),tickets:s.count,discounts:w(s.totalDiscounts??0),avgTicket:s.count>0?w(s.totalAmount/s.count):0,topRep:a?{name:a[0],amount:w(a[1])}:null})}case"get_top_brands_today":{let t=e.limit||5,a=[...(await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:"POS#REPORTING#SALES"}}))).Item?.brandRows??[]].sort((i,c)=>(c["source_sales.net_sales"]??0)-(i["source_sales.net_sales"]??0)).slice(0,t).map(i=>({brand:i["item.custom@brand"]??"Unknown",netSalesYTD:w(i["source_sales.net_sales"]??0),unitsYTD:i["source_sales.net_qty_sold"]??0}));return JSON.stringify({note:"YTD net sales (proxy for momentum)",topBrands:a})}case"get_low_stock_urgent":{let t=e.limit||10,s=(await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:"POS#INVENTORY#CATALOG"}}))).Item?.data?.lowStockItems??[],a=s.filter(i=>i.qty_on_hand<=1).slice(0,t);return JSON.stringify({urgentItems:a,totalLowStock:s.length})}case"get_recent_trend":{let t=e.days||7,r=Re(t),a=((await p.send(new l.QueryCommand({TableName:g,KeyConditionExpression:"userId = :uid AND sk BETWEEN :from AND :to",ExpressionAttributeValues:{":uid":y,":from":`POS#DAILY#${r}`,":to":`POS#DAILY#${o}`}}))).Items??[]).map(m=>{let u=m.rollup;return u?{date:u.date,revenue:w(u.totalAmount),tickets:u.count}:null}).filter(Boolean),i=a.reduce((m,u)=>m+u.revenue,0),c=a.length>0?w(i/a.length):0;return JSON.stringify({days:t,dailyAvg:c,totalRevenue:w(i),trend:a})}case"get_pending_opportunities":{let r=((await p.send(new l.QueryCommand({TableName:g,KeyConditionExpression:"userId = :uid AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":uid":y,":prefix":"OPP#"}}))).Items??[]).filter(s=>s.status!=="done").map(s=>({id:s.id,title:s.title,category:s.category,priority:s.priority,details:s.details,dueDate:s.dueDate??null,mentionCount:s.mentionCount??0,lastMentioned:s.lastMentioned??null,daysSinceLastMention:s.lastMentioned?Math.floor((Date.now()-new Date(s.lastMentioned).getTime())/864e5):null,createdAt:s.createdAt})).sort((s,a)=>a.priority-s.priority);return JSON.stringify({count:r.length,opportunities:r,guidance:"Priority 8-10: mention every email until done. Priority 5-7: mention every 2-3 emails. Priority 2-4: mention once unless updated."})}case"record_opportunity":{let t=e.id;if(!t||!/^[a-z0-9-]+$/.test(t))return JSON.stringify({error:"id must be kebab-case (lowercase letters, digits, hyphens)"});let s=(await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:`OPP#${t}`}}))).Item??{},a=new Date().toISOString();return await p.send(new l.PutCommand({TableName:g,Item:{userId:y,sk:`OPP#${t}`,id:t,title:e.title,category:e.category,priority:e.priority,details:e.details,dueDate:e.dueDate??s.dueDate??null,status:"open",mentionCount:s.mentionCount??0,lastMentioned:s.lastMentioned??null,createdAt:s.createdAt??a,updatedAt:a}})),JSON.stringify({ok:!0,id:t,action:s.createdAt?"updated":"created"})}case"update_opportunity":{let t=e.id;if(!t)return JSON.stringify({error:"id is required"});let r=await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:`OPP#${t}`}}));if(!r.Item)return JSON.stringify({error:`Opportunity ${t} not found`});let s=new Date().toISOString(),a={...r.Item,updatedAt:s};return e.mentionedToday&&(a.mentionCount=(r.Item.mentionCount??0)+1,a.lastMentioned=s),e.priority!==void 0&&(a.priority=e.priority),e.details!==void 0&&(a.details=e.details),e.dueDate!==void 0&&(a.dueDate=e.dueDate),await p.send(new l.PutCommand({TableName:g,Item:a})),JSON.stringify({ok:!0,id:t,mentionCount:a.mentionCount})}case"mark_opportunity_done":{let t=e.id;if(!t)return JSON.stringify({error:"id is required"});let r=await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:`OPP#${t}`}}));return r.Item?(await p.send(new l.PutCommand({TableName:g,Item:{...r.Item,status:"done",outcome:e.outcome??null,completedAt:new Date().toISOString()}})),JSON.stringify({ok:!0,id:t,status:"done"})):JSON.stringify({error:`Opportunity ${t} not found`})}case"scan_recent_vendor_emails":{let t=Math.min(e.days||14,30);try{let r=await Q(t);return JSON.stringify(r)}catch(r){return JSON.stringify({error:`Gmail scan failed: ${r.message}`})}}case"search_inbox":{let t=e.query,r=Math.min(e.max||10,30);if(!t)return JSON.stringify({error:"query is required"});try{let s=await F(t,r);return JSON.stringify({query:t,count:s.length,messages:s})}catch(s){return JSON.stringify({error:`Gmail search failed: ${s.message}`})}}case"read_email":{let t=e.id;if(!t)return JSON.stringify({error:"id is required"});try{let r=await z(t);return JSON.stringify(r)}catch(r){return JSON.stringify({error:`Gmail read failed: ${r.message}`})}}case"cache_query":try{return JSON.stringify(await q(e))}catch(t){return JSON.stringify({error:`cache_query failed: ${t.message}`})}case"cache_vendor_activity":{let t=String(e.vendor??"");if(!t)return JSON.stringify({error:"vendor is required"});let r=Math.min(Number(e.days)||90,365);try{return JSON.stringify(await ee(t,r))}catch(s){return JSON.stringify({error:`cache_vendor_activity failed: ${s.message}`})}}case"cache_read":{let t=String(e.id??"");if(!t)return JSON.stringify({error:"id is required"});let r=String(e.dateOnly??"")||void 0;try{let s=await Z(t,r);return JSON.stringify(s??{error:`Message ${t} not in cache`})}catch(s){return JSON.stringify({error:`cache_read failed: ${s.message}`})}}case"web_search":{let t=String(e.query??"");if(!t)return JSON.stringify({error:"query is required"});try{return JSON.stringify(await te(t,{topic:"news",days:Math.min(Number(e.days)||7,30),maxResults:Math.min(Number(e.maxResults)||5,10),includeAnswer:!0}))}catch(r){return JSON.stringify({error:`web_search failed: ${r.message}`})}}default:return JSON.stringify({error:`Unknown tool: ${n}`})}}async function Pe(n){return`You are the Sales Briefing AI for Foot Solutions Flower Mound.
Today's date (Central Time): ${K()}
Daily revenue target: $${n.toFixed(2)}

Your job: write a TIGHT daily briefing email for the new owner. Quality over quantity.
The owner will stop reading anything that's too long.

HARD CONSTRAINTS:
- Total email body MUST be 220 words or fewer (was 180; bumped to fit the optional Network Heads-up section without crowding the rest)
- 3-5 short sections, no walls of text
- Every recommendation MUST include a verified contact (name OR phone) and address
- Use real data \u2014 call tools to fetch actual numbers, never guess
- Tone: confident, direct, like a sharp consultant \u2014 never wishy-washy
- Store is CLOSED Sunday & Monday. Never suggest events on Sun/Mon.

\u2550\u2550\u2550 INBOX ACCESS \u2014 cache-first, live as fallback \u2550\u2550\u2550
You have read access to a LOCAL CACHE of the owner's Gmail (rolling ~6 month window) plus live Gmail as a fallback. The cache classifies every message by kind:
  - vendor   = from a known vendor brand or domain (Brooks, Dansko, Aetrex, etc.)
  - corporate= from Foot Solutions HQ (leadership, ops, marketing \u2014 Taylor, John, Jordan, Don, Gary, etc., plus production@, customerservice@, QuickBooks notifications, Voxelcare)
  - franchise= from a sister Foot Solutions store (katy@, greenville@, acworth@, etc.)
  - customer = inbound customer messages (appointment requests, fitting questions, complaints)
  - invoice  = bills with a dollar amount or due date
  - internal = mail from this store's own address (flowermound@)

PREFER cache tools \u2014 they're faster and free:
  - cache_query({ kind, vendor?, since, until, from?, text?, limit })
  - cache_vendor_activity(vendor, days?)   \u2014 vendor rollup with last contact + top senders
  - cache_read(id, dateOnly?)              \u2014 full body of a cached email

Live Gmail tools (only when cache doesn't cover what you need):
  - scan_recent_vendor_emails(days?)       \u2014 fast 14-day vendor sweep
  - search_inbox(query, max?)              \u2014 Gmail-syntax targeted search
  - read_email(id)                         \u2014 live full body fetch

\u2550\u2550\u2550 WEB SEARCH (Tavily) \u2014 sparingly \u2550\u2550\u2550
- web_search(query, days?, maxResults?) \u2014 last-N-day news. Use AT MOST 2 calls per email.
- Good uses: confirm a vendor announcement worth flagging, look up a Flower Mound or Denton County event date you're not 100% sure about.
- Bad uses: routine vendor names, generic queries. Skip if you don't have a sharp question.

\u2550\u2550\u2550 HOW TO USE THESE TOOLS IN THE BRIEFING \u2550\u2550\u2550
- Vendor stories: combine cache_vendor_activity + (optionally) one web_search for industry context.
- Corporate signals: cache_query({ kind: 'corporate', since: '<7 days ago>' }) \u2192 flag if HQ sent a regional sales report, marketing minute, training call, council vote, or system maintenance notice the owner should act on.
- Franchise signals: cache_query({ kind: 'franchise', since: '<3 days ago>' }) \u2192 mention if sister stores are reporting wins/losses on shared threads (peer benchmarks).
- Customer signals: cache_query({ kind: 'customer', since: '<3 days ago>' }) \u2192 flag unanswered appointment requests / fitting questions.

WHEN NOT TO USE INBOX TOOLS:
- Do not list random emails. Inbox hits should only inform recommendations.
- Do not quote email content verbatim in the briefing \u2014 paraphrase briefly.
- Do not reference personal/sensitive content. Stick to business signals.

If an inbox finding produces a strong follow-up, record_opportunity with priority based on time-sensitivity.

\u2550\u2550\u2550 MEMORY & CONTINUITY (this is critical) \u2550\u2550\u2550
You are the same agent every night. Use the opportunity ledger to keep
strategic items moving instead of starting fresh daily.

REQUIRED WORKFLOW for every email (do these in order):

1. FETCH: Call get_pending_opportunities AND scan_recent_vendor_emails first.
2. UPDATE STATE: For each pending opportunity, decide:
   - If the event date passed \u2192 mark_opportunity_done with outcome.
   - If priority is 8-10 (critical, time-sensitive) \u2192 include it in today's email,
     then call update_opportunity with mentionedToday=true.
   - If priority is 5-7 (important) and daysSinceLastMention >= 2 \u2192 include it,
     then call update_opportunity with mentionedToday=true.
   - If priority is 2-4 (notable) and mentionCount === 0 \u2192 include it once,
     then update_opportunity with mentionedToday=true.
   - Otherwise skip \u2014 don't repeat.
3. DISCOVER NEW: Look at today's sales data. If you spot a new opportunity
   (urgent reorder, upcoming event, partnership opening), call record_opportunity
   to save it for future emails. Set priority based on impact:
     10 = revenue-critical (e.g. top brand at 0 stock, lost sale risk)
      8 = high-value time-bound (e.g. paid sponsorship deadline this week)
      6 = solid recurring opportunity (e.g. monthly senior center demo)
      4 = nice-to-have (e.g. one-off chamber mixer)
      2 = informational
4. WRITE EMAIL: Use the structure below. Pull 1-2 high-impact items from
   pending + new discoveries. Don't list every opportunity \u2014 pick the most
   urgent and impactful for today.

This means high-priority items will appear in 3-5 emails until done.
Medium priority shows every 2-3 days. Low priority shows once.
Never repeat completed items. Never include all pending \u2014 be selective.

REQUIRED EMAIL STRUCTURE:

\u{1F3AF} STATUS LINE (one line, with emoji):
   "BEAT TARGET" / "MISSED TARGET BY $X" / "ON PACE" / "NO SALES TODAY"

\u{1F4CA} STATS (3 bullets max, one line each):
   - Today: $X \xB7 N tickets \xB7 avg $Y
   - vs target / vs yesterday
   - One standout: top rep, top brand, or notable trend

\u{1F4A1} ONE OR TWO HIGH-IMPACT MOVES (the meat \u2014 2-3 sentences each):
   Pull from pending opportunities (priority-driven) OR discover new ones
   from today's data. Each move MUST include:
     - WHO (target market segment)
     - WHERE (venue name + full street address)
     - WHEN (specific date Tue\u2013Sat only \u2014 never Sun/Mon)
     - HOW TO REACH (contact name + phone, drawn from the venue list below)

   If you're re-mentioning a tracked opportunity, frame it as a follow-up:
   "Reminder: \u2026" or "Still open: \u2026" or "Update on \u2026" \u2014 not as new.

\u{1F3E5} ONE QUICK INSIGHT (1 sentence):
   A small but impactful observation about today's data \u2014 e.g. margin opportunity,
   a brand that's slowing, a customer pattern.

\u{1F4E8} NETWORK HEADS-UP (0-2 lines, only when there is real signal):
   - Anything from HQ today/yesterday that needs action: regional report deadline,
     marketing minute with a CTA, council vote, system maintenance, training call,
     leadership announcement. Keep it to one sentence per item.
   - If a sister store posted something relevant on a shared thread (a vendor tip,
     a customer outcome, a regional trend), summarize it in one sentence.
   - Skip this section entirely if nothing new from corporate or sister stores
     reaches the bar of "owner action or awareness needed."
   - Always cite the source: "(HQ \u2014 Taylor, Mon)" or "(Katy store, Sun)".

DO NOT include generic advice. DO NOT pad. DO NOT explain your reasoning in the email.
DO NOT mention the opportunity ledger system to the reader \u2014 keep it invisible.
Use the curated market intelligence below to ground every suggestion in real local geography.
Always pull contact info (names + phones) from the venue list \u2014 never invent.

${Ce}

Begin by calling get_pending_opportunities, then gather sales data, then write
the email body in plain text (no markdown, no asterisks). Use the emoji headers
shown above. After writing the email, remember to call update_opportunity for
each item you mentioned (so the mention counter increments).`}function Le(n,e,o){let r={beat:"#10b981",miss:"#ef4444",pace:"#3b82f6",none:"#6b7280"}[o],s=n.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").split(`
`).map(a=>a.trim()).filter(Boolean).map(a=>`<p style="margin: 0 0 12px 0; line-height: 1.55;">${a}</p>`).join("");return`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Foot Solutions Daily Briefing \u2014 ${e}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="background:${r};padding:18px 24px;color:#ffffff;">
          <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:1px;opacity:0.9;">DAILY BRIEFING</p>
          <p style="margin:4px 0 0 0;font-size:18px;font-weight:700;">${e}</p>
        </td></tr>
        <tr><td style="padding:24px;font-size:14px;color:#1e293b;">
          ${s}
        </td></tr>
        <tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;">
          Foot Solutions Flower Mound \xB7 Generated by your AI assistant \xB7 <a href="https://fsmanagementsystem.com" style="color:#3b82f6;text-decoration:none;">Open dashboard</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`}async function Be(){return(await p.send(new l.GetCommand({TableName:g,Key:{userId:y,sk:"ADMIN#SETTINGS"}}))).Item?.dailyTarget??1500}var $e=async n=>{let e=K(),o=Oe(),t=n?.trigger?.startsWith("manual")??!1;if(xe.has(o)&&!t)return console.log(`Skipping daily report for ${e} (day of week ${o} \u2014 store closed)`),{ok:!0,skipped:!0,reason:"store-closed-day"};console.log(`Daily report start for ${e}`);let r=await Be(),s=await Pe(r),a=[{role:"user",content:[{text:`Generate today's briefing for ${e}. Daily target is $${r.toFixed(2)}. Use the tools to fetch real numbers first, then write a tight email per the structure rules.`}]}],i="",c=16;for(let T=0;T<c;T++){let R=await Ie.send(new x.ConverseCommand({modelId:_e,system:[{text:s}],messages:a,toolConfig:{tools:Ne},inferenceConfig:{maxTokens:1500,temperature:.4}})),C=R.output?.message?.content??[],N=R.stopReason;if(a.push({role:"assistant",content:C}),N==="end_turn"||N==="max_tokens"){let v=C.find(M=>"text"in M);v&&"text"in v&&(i=(v.text??"").trim());break}if(N==="tool_use"){let v=C.filter(k=>"toolUse"in k),M=await Promise.all(v.map(async k=>{if(!("toolUse"in k)||!k.toolUse)return{toolResult:{toolUseId:"unknown",content:[{text:"Invalid tool call"}]}};let{toolUseId:Y,name:J,input:W}=k.toolUse;console.log(`Tool: ${J}`,JSON.stringify(W));try{let P=await Me(J??"",W??{});return{toolResult:{toolUseId:Y??"",content:[{text:P}],status:"success"}}}catch(P){return{toolResult:{toolUseId:Y??"",content:[{text:`Error: ${P.message}`}],status:"error"}}}}));a.push({role:"user",content:M});continue}break}i||(i="\u26A0\uFE0F No briefing generated today. Check Lambda logs for details.");let m=i.toLowerCase(),u=m.includes("no sales")?"none":m.includes("beat target")?"beat":m.includes("missed target")?"miss":"pace",S=`Foot Solutions \u2014 Daily Briefing \xB7 ${e}`,d=Le(i,e,u),f="sent",h=null;try{await Ae.send(new O.SendEmailCommand({FromEmailAddress:`Foot Solutions Briefing <${ne}>`,Destination:{ToAddresses:[D]},ReplyToAddresses:[D],Content:{Simple:{Subject:{Data:S,Charset:"UTF-8"},Body:{Html:{Data:d,Charset:"UTF-8"},Text:{Data:i,Charset:"UTF-8"}},Headers:[{Name:"List-Unsubscribe",Value:`<mailto:${D}?subject=unsubscribe>`},{Name:"List-Unsubscribe-Post",Value:"List-Unsubscribe=One-Click"},{Name:"X-Entity-Ref-ID",Value:`daily-briefing-${e}`}]}}})),console.log(`Email sent to ${D}`)}catch(T){f="failed",h=T.message,console.error("SES send failed:",h)}return await p.send(new l.PutCommand({TableName:g,Item:{userId:y,sk:`EMAIL#${e}`,date:e,subject:S,bodyText:i,bodyHtml:d,status:u,sendStatus:f,sendError:h,to:D,from:ne,generatedAt:new Date().toISOString()}})),{ok:f==="sent",status:u,sendStatus:f,sendError:h}};0&&(module.exports={handler});
