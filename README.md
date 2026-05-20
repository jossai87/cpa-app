# Foot Solutions Management Platform

Serverless management app for the Foot Solutions franchise — Flower Mound, TX.

**Stack:** React · Vite · Tailwind · AWS CDK v2 · Lambda · API Gateway · Cognito · Bedrock · DynamoDB · S3 · CloudFront · Secrets Manager

---

## Prerequisites

```bash
node --version   # 20.x LTS
aws --version    # AWS CLI v2
```

Configure AWS credentials (one-time):

```bash
aws configure
aws sts get-caller-identity   # verify
```

---

## Project Structure

```
/                  ← React frontend (Vite)
/lambda            ← Lambda handlers (TypeScript)
/infrastructure    ← AWS CDK stack
/documents         ← Local reference docs (not deployed)
```

---

## Install Everything

```bash
npm install                        # frontend
npm install --prefix lambda        # lambda handlers
npm install --prefix infrastructure  # CDK
```

---

## Local Development

**1. Create your env file** (root of project):

```bash
cp .env.example .env.local
```

Fill in `.env.local` with values from your deployed stack:

```env
VITE_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/prod
VITE_APP_URL=https://<your-cloudfront-or-localhost>
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com
```

**2. Start the dev server:**

```bash
npm run dev
```

App runs at `http://localhost:3000`.

---

## Deployment

### Bootstrap (one-time per AWS account/region)

```bash
cd infrastructure
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

---

### Full Deploy (infrastructure + frontend)

Builds lambdas, deploys CDK stack, builds frontend, syncs to S3, and invalidates CloudFront — all in sequence:

```bash
# 1. Deploy infrastructure (lambdas are bundled by CDK automatically)
cd infrastructure && npx cdk deploy FootSolutionsStack --require-approval never

# 2. Build and deploy frontend
cd ..
npm run build

BUCKET=<FootSolutionsStack.S3BucketName>
DIST_ID=<FootSolutionsStack.CloudFrontDistId>

aws s3 sync dist/ s3://$BUCKET/ --delete \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html s3://$BUCKET/index.html \
  --cache-control "no-cache, no-store, must-revalidate"

aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/*"
```

CDK outputs after deploy — copy these into `.env.local`:

```
FootSolutionsStack.ApiUrl            = https://...
FootSolutionsStack.UserPoolId        = us-east-1_...
FootSolutionsStack.UserPoolClientId  = ...
FootSolutionsStack.CloudFrontUrl     = https://...
FootSolutionsStack.S3BucketName      = ...
FootSolutionsStack.CloudFrontDistId  = ...
```

---

### Frontend-Only Deploy

Use this when you've only changed React/UI code and don't need to touch the backend:

```bash
npm run build

BUCKET=<FootSolutionsStack.S3BucketName>
DIST_ID=<FootSolutionsStack.CloudFrontDistId>

aws s3 sync dist/ s3://$BUCKET/ --delete \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html s3://$BUCKET/index.html \
  --cache-control "no-cache, no-store, must-revalidate"

aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/*"
```

---

### Infrastructure-Only Deploy

Use this when you've changed Lambda code, CDK stack, or environment config:

```bash
cd infrastructure
npx cdk deploy FootSolutionsStack --require-approval never
```

---

## Credentials Vault

Credentials are stored in AWS Secrets Manager under the prefix `foot-solutions/credentials/`.
The vault page lists them automatically — just add a secret and refresh.

**Add a new credential:**

```bash
aws secretsmanager create-secret \
  --name "foot-solutions/credentials/<slug>" \
  --region us-east-1 \
  --secret-string '{
    "name": "Display Name",
    "url": "https://example.com",
    "username": "user@example.com",
    "password": "your-password"
  }'
```

**Update an existing credential's password:**

```bash
aws secretsmanager put-secret-value \
  --secret-id "foot-solutions/credentials/<slug>" \
  --region us-east-1 \
  --secret-string '{
    "name": "Display Name",
    "url": "https://example.com",
    "username": "user@example.com",
    "password": "new-password"
  }'
```

**Example — add the corporate Gmail:**

```bash
aws secretsmanager create-secret \
  --name "foot-solutions/credentials/gmail-corporate" \
  --region us-east-1 \
  --secret-string '{
    "name": "Foot Solutions Corporate Gmail",
    "url": "https://mail.google.com",
    "username": "NancyandJustin@footsolutions.com",
    "password": "YOUR_TEMP_PW"
  }'
```

---

## Tear Down

```bash
cd infrastructure
npx cdk destroy FootSolutionsStack
```

> ⚠️ Deletes all AWS resources including DynamoDB data. Not reversible.

---

## Security Notes

- Never commit `.env.local` — it's in `.gitignore`
- Never commit `foot-solutions-buildout-plan.md` to a public repo
- Passwords live in Secrets Manager only — never in DynamoDB or React state
