# Foot Solutions Management Platform — Build Plan

> **Status:** Pre-build scoping document  
> **Owner:** Foot Solutions — Denton County, Texas  
> **Date:** May 2026  
> **Stack:** React · S3 · CloudFront · Cognito · API Gateway (HTTP) · Lambda · DynamoDB · Bedrock Nova 2 Lite · BDA · Secrets Manager

---

## 1. Overview

A serverless management platform for the Foot Solutions franchise in Denton County, Texas. Single owner, low traffic, cost-sensitive — so the architecture follows a straightforward **3-tier serverless pattern**: static frontend → API layer → data/AI layer. No containers, no VPCs, no queues, no event buses. Just the services that are actually needed.

The app is gated behind Cognito login and lands on a **"Foot Solutions mngnt screen"** dashboard. The first fully built module is the **CPA Tax Assistant**. All other tiles are scaffolded as placeholders for future buildout.

### 3-Tier Breakdown

| Tier | What it is | Services |
|---|---|---|
| **Presentation** | React SPA, static files, auth | S3 + CloudFront + Cognito |
| **Application** | Business logic, AI calls, doc handling | API Gateway (HTTP) + Lambda |
| **Data** | Storage, AI models, secrets | DynamoDB + S3 (docs) + Bedrock + Secrets Manager |

---

## 2. Main Dashboard — "Foot Solutions mngnt screen"

Post-login landing page. Tile grid navigation — one active module, rest are placeholders.

| Tile | Status | Description |
|---|---|---|
| **CPA Tax Assistant** | ✅ Built | Upload year-end docs, run AI-powered tax calculations |
| **Credentials** | ✅ Built | Masked service logins with copy + update (Secrets Manager) |
| **Sales & Revenue** | 🔲 Placeholder | Future module |
| **Inventory** | 🔲 Placeholder | Future module |
| **Payroll** | 🔲 Placeholder | Future module |
| **Franchise Compliance** | 🔲 Placeholder | Future module |
| **Reports** | 🔲 Placeholder | Future module |

---

## 3. Architecture

### 3.1 High-Level Flow

```
┌─────────────────────────────────────────────────────┐
│  TIER 1 — PRESENTATION                              │
│                                                     │
│  Browser → CloudFront → S3 (React SPA)              │
│                ↓                                    │
│           Cognito Login (JWT issued)                │
└─────────────────────────────────────────────────────┘
                    ↓ JWT on every request
┌─────────────────────────────────────────────────────┐
│  TIER 2 — APPLICATION                               │
│                                                     │
│  API Gateway (HTTP API)                             │
│    ↓ Cognito JWT Authorizer (all routes)            │
│  Lambda Functions (3 handlers)                      │
│    • taxHandler     → tax calc + Bedrock calls      │
│    • documentHandler → S3 upload URLs + BDA jobs    │
│    • credentialHandler → Secrets Manager CRUD       │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│  TIER 3 — DATA                                      │
│                                                     │
│  DynamoDB          → tax session history            │
│  S3 (private)      → uploaded CPA documents         │
│  Bedrock Nova 2 Lite → AI tax analysis              │
│  Bedrock BDA       → document data extraction       │
│  Secrets Manager   → third-party credentials        │
└─────────────────────────────────────────────────────┘
```

### 3.2 Service Choices — Why Each One

| Service | Why it's here | Why we're NOT using the alternative |
|---|---|---|
| **S3 + CloudFront** | Cheapest way to host a React SPA globally with HTTPS | Amplify Hosting adds cost and abstraction you don't need |
| **Cognito** | Managed auth, free up to 50K MAU, JWT works natively with API Gateway | Building custom auth is a security risk |
| **API Gateway HTTP API** | ~70% cheaper than REST API, supports Cognito JWT authorizer natively | REST API has features (usage plans, caching) you don't need yet |
| **Lambda** | Pay-per-call, zero idle cost, scales automatically | ECS/Fargate is overkill for this traffic volume |
| **DynamoDB on-demand** | No provisioned capacity to manage, pay only for what you use | RDS requires a VPC, always-on instance cost, more ops overhead |
| **Bedrock Nova 2 Lite** | Best price-performance for document reasoning in the Nova family | Nova Pro/Premier are more capable but 3–5x more expensive |
| **Bedrock BDA** | Replaces a Textract + parsing Lambda + prompt engineering pipeline with one API call | Textract alone doesn't give you structured JSON — you'd still need extra code |
| **Secrets Manager** | Purpose-built for credentials, supports rotation, ~$0.40/secret/month | SSM Parameter Store SecureString works too but Secrets Manager has better rotation support |

### 3.3 What We're Deliberately Leaving Out

| Skipped Service | Reason |
|---|---|
| AWS WAF | ~$5/mo base + per-request cost. Not justified for a single-owner internal tool. Add if you ever open this to the public. |
| VPC / Private Subnets | Lambda works fine without a VPC for this stack. VPCs add NAT Gateway cost (~$32/mo) and complexity. |
| SQS / EventBridge | No async fan-out needed. Lambda calls Bedrock synchronously — simple and debuggable. |
| Step Functions | Only one workflow (upload → BDA → Bedrock). A single Lambda handles it fine. |
| Multiple CDK stacks | One `FootSolutionsStack` is enough. Split stacks only when teams or deployment cadences diverge. |
| Cognito user groups / roles | Single owner for now. Add `accountant` group in Phase 3 if needed. |
| S3 Object Lock / Versioning | Useful for compliance, not needed for MVP. Enable on the docs bucket in Phase 3. |
| CloudWatch Dashboards / Alarms | Use the default Lambda/API Gateway metrics in the console for now. Add alarms when you have SLAs to meet. |

### 3.4 Infrastructure as Code

**AWS CDK v2 (TypeScript)** — single stack file. Keeps everything reproducible and in version control.

```
infrastructure/
└── lib/
    └── foot-solutions-stack.ts   ← everything in one stack
```

---

## 4. Authentication — Cognito (Keep It Simple)

- Cognito **User Pool**, email + password login
- Use **Amplify Auth** (`aws-amplify`) in the React app — handles token storage, refresh, and sign-out automatically
- API Gateway **HTTP API with Cognito JWT Authorizer** — one line of CDK, protects all routes
- No custom login UI needed in Phase 1 — use Cognito's **Hosted UI** (free, handles the login page for you)
- Swap to a custom React login form in Phase 2 if you want branded styling

That's it. No MFA, no user groups, no identity pools for now.

---

## 5. CPA Tax Assistant Module

### 5.1 What It Does

1. Owner fills out a structured form with key financial figures (MVP — no file upload yet)
2. Optionally toggles **"Calculate by Standards"** to auto-apply IRS/Texas standard rates
3. Lambda sends the data to Bedrock Nova 2 Lite with a structured prompt
4. Bedrock returns a plain-English tax summary + line-item estimates
5. Result is saved to DynamoDB and displayed in the UI

Phase 2 adds document upload → BDA extraction → auto-populate the form fields.

### 5.2 Texas & Denton County Tax Context (Pre-loaded in Lambda)

These values are hardcoded as constants in the Lambda — no external API calls needed.

#### Sales Tax
| Component | Rate |
|---|---|
| Texas state | 6.25% |
| City of Denton | 1.5% |
| Denton County Transportation Authority | 0.5% |
| **Combined total** | **8.25%** |

#### Texas Franchise Tax (Margin Tax)
- No Tax Due Threshold: **$2.47M** annualized revenue — below this, just file a PIR/OIR
- If above threshold, taxable margin = lowest of:
  1. 70% of total revenue
  2. Revenue minus COGS
  3. Revenue minus compensation
  4. Revenue minus $1M
- Standard rate: **0.75%** — retail/wholesale reduced rate: **0.375%** (Foot Solutions likely qualifies)
- Annual report due: **May 15**

#### Federal / Franchise-Specific
- Royalty fees, ad fund contributions, lease payments → fully deductible
- Initial franchise fee → amortized over 15 years (Section 197)
- Equipment (scanners, POS, orthotics printer) → Section 179 expensing
- QBI deduction → up to 20% for pass-through entities

---

## 6. Required CPA Documents — Input Checklist

### 6.1 Business Identity
- [ ] EIN Confirmation Letter (IRS CP-575 or 147C) — *required*
- [ ] Business entity documents (Articles of Org, Operating Agreement) — *required*
- [ ] Prior year federal tax return — *required*
- [ ] Prior year Texas Franchise Tax report — *required*
- [ ] FDD Item 6 (fee schedule) or manual royalty % entry — *required*

### 6.2 Income
- [ ] Profit & Loss Statement — full year — *required*
- [ ] Sales reports (POS exports) — *required*
- [ ] Bank statements — all accounts, full year — *required*
- [ ] Credit card statements — all business cards, full year — *required*
- [ ] 1099-K (Square, Stripe, PayPal) — *if applicable*
- [ ] 1099-NEC received — *if applicable*

### 6.3 Expenses
- [ ] Categorized expense log / receipts — *required*
- [ ] Payroll records (W-2s, 941s, payroll summaries) — *required if employees*
- [ ] 1099-NEC issued to contractors — *if applicable*
- [ ] Lease/rent agreement + payment records — *required*
- [ ] Loan documents (principal/interest breakdown) — *if applicable*
- [ ] Franchise royalty statements from Foot Solutions corporate — *required*
- [ ] Advertising fund contribution records — *required*
- [ ] Inventory records (beginning + ending values) — *required*
- [ ] COGS report — *required*

### 6.4 Assets & Depreciation
- [ ] Fixed asset list (equipment, furniture, leasehold improvements) — *required*
- [ ] Prior year depreciation schedule — *required*
- [ ] Receipts for new equipment purchased during the year — *if applicable*

### 6.5 Texas-Specific
- [ ] Texas Sales Tax returns filed during the year — *required*
- [ ] Prior year Texas Franchise Tax report (Form 05-158 or 05-169) — *required*
- [ ] Prior year Public Information Report (PIR) — *required*

### 6.6 Owner / Personal (pass-through entities)
- [ ] Owner SSN or ITIN — *entered in form, never uploaded*
- [ ] Ownership percentage — *if multi-member*
- [ ] Health insurance premiums paid by business for owner — *if applicable*
- [ ] Home office details (sq footage) — *if applicable*
- [ ] Business vehicle mileage log — *if applicable*

---

## 7. "Calculate by Standards" Toggle

When enabled, Lambda auto-applies these values without requiring manual input:

| Standard | Value |
|---|---|
| IRS Standard Mileage Rate | 70¢/mile (2025) |
| Section 179 Expensing | Up to $1.16M for eligible equipment |
| QBI Deduction | 20% of qualified business income |
| Home Office (simplified) | $5/sq ft, max 300 sq ft |
| Texas Franchise Tax Method | Auto-selects most favorable of the 4 margin methods |
| Denton Sales Tax Rate | 8.25% pre-populated |
| Franchise Tax Rate | 0.375% reduced retail rate |

---

## 8. Bedrock Integration

### Model
**Amazon Nova 2 Lite** (`amazon.nova-2-lite-v1:0`) — cost-effective reasoning model, multimodal, released at re:Invent 2025. Right-sized for this use case.

### Lambda Prompt Pattern

One Lambda (`taxHandler`) handles the full flow:

```
1. Receive form data from API Gateway
2. Build system prompt with TX tax context + business details
3. Call Bedrock InvokeModel (synchronous — simple, no streaming needed)
4. Parse JSON response
5. Write result to DynamoDB
6. Return result to frontend
```

No Step Functions, no queues. The whole thing runs in one Lambda invocation under 10 seconds.

### Bedrock Response Shape

```json
{
  "estimatedFederalTaxableIncome": 0,
  "estimatedFederalTaxLiability": 0,
  "estimatedTexasFranchiseTax": 0,
  "texasMarginMethodUsed": "revenue_minus_cogs",
  "estimatedSalesTaxOwed": 0,
  "keyDeductions": [],
  "flaggedForCPAReview": [],
  "ownerSummary": "Plain English explanation...",
  "disclaimer": "Estimate only. Consult a licensed CPA."
}
```

### Document Parsing — Bedrock Data Automation (BDA) — Phase 2

BDA is a single API call that replaces what would otherwise be: Textract + parsing Lambda + prompt engineering. It's GA as of March 2025.

**Flow (Phase 2):**
1. User uploads a document to S3 (pre-signed URL)
2. Lambda calls `InvokeDataAutomationAsync` with the S3 key
3. BDA uses a custom **Blueprint** (JSON schema) to extract the right fields per document type
4. Extracted JSON auto-populates the tax input form
5. User reviews, adjusts if needed, then runs the calculation

**Planned Blueprints:**

| Blueprint | Document | Fields Extracted |
|---|---|---|
| `profit-loss` | P&L Statement | Revenue, COGS, gross profit, net income, expense categories |
| `bank-statement` | Bank Statement | Monthly totals, ending balance |
| `payroll-summary` | Payroll Report | Total wages, employer taxes, headcount |
| `royalty-statement` | Foot Solutions Royalty Report | Gross sales, royalty %, royalty amount, ad fund |
| `sales-tax-return` | TX Sales Tax Return | Taxable sales, tax collected, tax remitted |
| `fixed-assets` | Depreciation Schedule | Asset names, purchase dates, cost basis, accumulated depreciation |

---

## 9. Lambda Design — 3 Handlers (Not 1 Per Route)

Rather than one Lambda per endpoint (expensive cold starts, harder to manage), group by domain:

| Handler | Routes it serves | Downstream calls |
|---|---|---|
| `taxHandler` | `POST /tax/calculate`, `GET /tax/history`, `GET /tax/history/{id}` | Bedrock, DynamoDB |
| `documentHandler` | `POST /documents/upload-url`, `POST /documents/bda-job` | S3, BDA |
| `credentialHandler` | `GET /credentials`, `POST /credentials/{id}/copy`, `PUT /credentials/{id}` | Secrets Manager |

Each handler uses a simple `switch` on the route path. One IAM role per handler, scoped to only the services it touches.

---

## 10. API Design

All routes use **API Gateway HTTP API** (not REST API — ~70% cheaper). All protected by Cognito JWT authorizer.

| Method | Route | Handler | Description |
|---|---|---|---|
| `POST` | `/tax/calculate` | `taxHandler` | Run Bedrock tax analysis |
| `GET` | `/tax/history` | `taxHandler` | List past sessions for the user |
| `GET` | `/tax/history/{id}` | `taxHandler` | Get a specific session result |
| `POST` | `/documents/upload-url` | `documentHandler` | Get S3 pre-signed upload URL |
| `POST` | `/documents/bda-job` | `documentHandler` | Trigger BDA extraction on uploaded doc |
| `GET` | `/credentials` | `credentialHandler` | List credentials (passwords masked) |
| `POST` | `/credentials/{id}/copy` | `credentialHandler` | Return raw password once for clipboard |
| `PUT` | `/credentials/{id}` | `credentialHandler` | Update password in Secrets Manager |

---

## 11. Data Model (DynamoDB — Single Table)

One table, two entity types. Simple and cheap.

```
Table: FootSolutionsApp
  PK: userId (Cognito sub)
  SK: varies by entity type

Tax Session:
  PK: userId
  SK: "TAX#<sessionId>"
  taxYear, entityType, inputData (map), useStandards,
  bedrockResponse (map), createdAt, status

(Future) Credential Metadata:
  PK: userId
  SK: "CRED#<credentialId>"
  name, url, username, secretManagerKey
  (password never stored in DynamoDB — always in Secrets Manager)
```

---

## 12. Frontend — React App Structure

Simple and flat. No over-abstracted state management (no Redux). Use React's built-in `useState`/`useContext` + React Query for data fetching.

```
src/
├── pages/
│   ├── Login.tsx              # Cognito Hosted UI redirect or Amplify Auth form
│   ├── Dashboard.tsx          # "Foot Solutions mngnt screen" tile grid
│   ├── CpaTaxAssistant.tsx    # Tax form + results
│   └── Credentials.tsx        # Credential vault table
├── components/
│   ├── TileCard.tsx           # Dashboard tile
│   ├── TaxForm.tsx            # Input form with "Calculate by Standards" toggle
│   ├── TaxResult.tsx          # Bedrock response display
│   ├── CredentialRow.tsx      # Single credential row with copy + edit
│   └── Spinner.tsx
├── hooks/
│   ├── useTaxSessions.ts      # React Query hook for tax history
│   └── useCredentials.ts      # React Query hook for credentials
├── lib/
│   ├── api.ts                 # Axios instance with Cognito token injected
│   └── auth.ts                # Amplify Auth helpers
└── App.tsx
```

### UI Library
**Tailwind CSS + shadcn/ui** — lightweight, no heavy component library bundle, looks clean, easy to customize. Much lighter than Cloudscape for a single-owner internal tool.

---

## 13. Credential Vault — Secrets Manager

### How It Works

```
GET /credentials  →  credentialHandler Lambda
  → GetSecretValue for each credential
  → Returns: { name, url, username, password: "••••••••" }
  (raw password never leaves Lambda on list calls)

POST /credentials/{id}/copy  →  credentialHandler Lambda
  → GetSecretValue
  → Returns raw password ONCE
  → React writes to clipboard via Clipboard API, discards immediately
  (never stored in state, DOM, or localStorage)

PUT /credentials/{id}  →  credentialHandler Lambda
  → GetSecretValue (read existing fields)
  → PutSecretValue (merge new password, preserve name/url/username)
  → Returns 200 OK
```

### Secret Structure

Path convention: `foot-solutions/credentials/<service-name>`

```json
{
  "name": "Global Payments",
  "url": "https://...",
  "username": "flowermound@footsolutions.com",
  "password": "Foot1000$"
}
```

### UI Behavior

| Column | Behavior |
|---|---|
| Service Name | Plain text |
| URL | Clickable link |
| Username | Plain text |
| Password | Always `••••••••` — never sent to browser on list load |
| Copy | Triggers `/copy` endpoint → writes to clipboard → discards |
| Edit | Inline form, `type="password"` field, confirm field, disabled until both match |

### Lambda IAM (credentialHandler only)

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue"
  ],
  "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/credentials/*"
}
```

### Adding New Credentials

Done via AWS CLI or Secrets Manager console — not through the app UI. Keeps write-new-secret access out of the frontend entirely.

```bash
aws secretsmanager create-secret \
  --name "foot-solutions/credentials/<service>" \
  --secret-string '{"name":"...","url":"...","username":"...","password":"..."}'
```

---

## 14. Security — Practical Basics (No Over-Engineering)

| Practice | How |
|---|---|
| All routes authenticated | Cognito JWT authorizer on API Gateway — one config, covers everything |
| S3 static site not publicly accessible | CloudFront OAC — S3 bucket policy blocks direct access |
| S3 docs bucket private | No public access, pre-signed URLs only |
| Lambda least-privilege | One IAM role per handler, scoped to only the services it calls |
| DynamoDB access scoped to user | Lambda filters by `userId` from JWT — users can't see each other's data |
| Passwords never in frontend | Secrets Manager only, raw value only returned on explicit copy action |
| No secrets in env vars | Lambda reads from Secrets Manager at runtime using the Parameters & Secrets Lambda Extension (caches for 5 min — avoids per-call cost) |
| Sensitive data not logged | Lambda strips SSN, EIN, passwords before any CloudWatch logging |

That's it. No WAF, no VPC, no GuardDuty — those are valid additions later if the app grows or goes multi-user.

---

## 15. Cost Estimate (Monthly — Single Owner)

| Service | Usage | Cost |
|---|---|---|
| S3 (static + docs) | < 5 GB | ~$0.12 |
| CloudFront | Low traffic | ~$1–3 |
| Cognito | < 50 MAU | **Free** |
| API Gateway (HTTP) | < 10K req/mo | ~$0.01 |
| Lambda | < 10K invocations | **Free tier** |
| DynamoDB (on-demand) | Low volume | ~$0.25 |
| Secrets Manager | ~5 secrets | ~$2.00 |
| Bedrock Nova 2 Lite | ~50 tax runs/mo | ~$3–8 |
| Bedrock BDA | ~50 doc jobs/mo (Phase 2) | ~$2–6 |
| **Total** | | **~$10–20/month** |

---

## 16. Build Phases

### Phase 1 — MVP (3–4 weeks)
- Cognito Hosted UI login
- "Foot Solutions mngnt screen" dashboard (CPA + Credentials tiles active, rest placeholder)
- CPA Tax Assistant — structured form input, "Calculate by Standards" toggle, Bedrock Nova 2 Lite analysis, DynamoDB history
- Credential Vault — list, copy, update password via Secrets Manager
- Single CDK stack deployment to S3 + CloudFront

### Phase 2 — Document Upload + BDA (2–3 weeks)
- S3 document upload (pre-signed URLs)
- Document checklist UI with upload status per doc
- BDA project + Blueprints for each document type
- Auto-populate tax form from BDA extraction output

### Phase 3 — Expand (ongoing)
- Remaining dashboard modules (Sales, Inventory, Payroll, Franchise Compliance)
- PDF export of tax summaries
- Custom branded login form (replace Hosted UI)
- Multi-user: add `accountant` Cognito group with read-only access

---

## 17. Key References

- [Deploy React SPA to S3 + CloudFront](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/deploy-a-react-based-single-page-application-to-amazon-s3-and-cloudfront.html)
- [API Gateway HTTP API vs REST API pricing](https://aws.amazon.com/api-gateway/pricing/)
- [Texas Franchise Tax — TX Comptroller](https://comptroller.texas.gov/taxes/franchise/)
- [Denton Sales Tax Rate — 8.25%](https://www.avalara.com/taxrates/en/state-rates/texas/cities/merit.html)
- [Amazon Nova 2 Lite model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html)
- [Bedrock Data Automation — GA](https://aws.amazon.com/blogs/aws/get-insights-from-multimodal-content-with-amazon-bedrock-data-automation-now-generally-available/)
- [BDA Custom Blueprints](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-custom-output-idp.html)
- [AWS Secrets Manager + Lambda Extension](https://aws.amazon.com/blogs/compute/using-the-aws-parameter-and-secrets-lambda-extension-to-cache-parameters-and-secrets/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Foot Solutions Franchise](https://footsolutions.com/franchising/)

---

*Scoping and planning reference only. Not tax or legal advice. Consult a licensed CPA for actual filings.*

---

## 18. Login Credentials

> ⚠️ **Keep this document secure. Do not commit to a public repository.**  
> These are for initial entry into Secrets Manager only. Once loaded, remove the plaintext passwords from this doc.

| Service | URL | Username / Email | Secret Path | Password |
|---|---|---|---|---|
| Global Payments | *(TBD)* | flowermound@footsolutions.com | `foot-solutions/credentials/global-payments` | Foot1000$ |
