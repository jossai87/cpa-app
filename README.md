# Foot Solutions Management Platform

Serverless management app for the Foot Solutions franchise — Denton County, Texas.

**Stack:** React · Vite · Tailwind · shadcn/ui · AWS CDK v2 · Lambda · API Gateway · Cognito · Bedrock Nova 2 Lite · BDA · DynamoDB · S3 · CloudFront · Secrets Manager

---

## Prerequisites

```bash
node --version    # 20.x LTS required
npm --version     # 10.x (bundled with Node 20)
aws --version     # AWS CLI v2
cdk --version     # AWS CDK v2
```

Install CDK globally if you haven't:

```bash
npm install -g aws-cdk
```

Configure your AWS credentials:

```bash
aws configure
# then verify:
aws sts get-caller-identity
```

---

## Install

```bash
# Frontend
cd frontend && npm install

# Lambda handlers
cd lambdas && npm install

# CDK infrastructure
cd infrastructure && npm install
```

---

## Run Locally

**1. Set up your environment variables:**

```bash
cd frontend
cp .env.example .env.local
```

Fill in `.env.local` with values from your deployed stack (or a dev stack):

```env
VITE_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/prod
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_COGNITO_REGION=us-east-1
```

**2. Start the dev server:**

```bash
cd frontend
npm run dev
```

App runs at `http://localhost:5173`. API calls are proxied to your API Gateway URL via the Vite dev server config — no CORS issues locally.

---

## CDK Deployment

**Bootstrap (one-time per AWS account/region):**

```bash
cd infrastructure
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

**Deploy everything:**

```bash
cd infrastructure
cdk deploy FootSolutionsStack
```

CDK will print outputs when complete — copy these into your `.env.local`:

```
FootSolutionsStack.ApiUrl              = https://...
FootSolutionsStack.UserPoolId          = us-east-1_...
FootSolutionsStack.UserPoolClientId    = ...
FootSolutionsStack.CloudFrontUrl       = https://...
FootSolutionsStack.S3BucketName        = ...
FootSolutionsStack.CloudFrontDistId    = ...
```

**Deploy frontend to S3 + invalidate CloudFront:**

```bash
cd frontend && npm run build

BUCKET=<FootSolutionsStack.S3BucketName>
DIST=<FootSolutionsStack.CloudFrontDistId>

aws s3 sync dist/ s3://$BUCKET/ --delete \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html s3://$BUCKET/index.html \
  --cache-control "no-cache, no-store, must-revalidate"

aws cloudfront create-invalidation --distribution-id $DIST --paths "/*"
```

**Tear down:**

```bash
cd infrastructure
cdk destroy FootSolutionsStack
```

> ⚠️ This deletes all resources including DynamoDB data. Not reversible.

---

## Loading Credentials into Secrets Manager

Run once per credential after deploying:

```bash
aws secretsmanager create-secret \
  --name "foot-solutions/credentials/global-payments" \
  --secret-string '{"name":"Global Payments","url":"","username":"flowermound@footsolutions.com","password":"Foot1000$"}'
```

---

## Security Notes

- Never commit `.env.local` — it's in `.gitignore`
- Never commit `foot-solutions-buildout-plan.md` to a public repo (contains credentials)
- Passwords are never stored in DynamoDB or React state — Secrets Manager only
