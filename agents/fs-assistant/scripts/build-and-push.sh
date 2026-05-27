#!/usr/bin/env bash
# Build the FS Assistant ARM64 image and push it to the ECR repo
# provisioned by `infrastructure/lib/fs-assistant-stack.ts` (Task 9.1).
#
# Usage (from the repo root):
#   ./agents/fs-assistant/scripts/build-and-push.sh [image-tag]
#
# Defaults:
#   AWS_REGION  → us-east-1
#   ECR_REPO    → foot-solutions-fs-assistant
#   IMAGE_TAG   → latest
#
# Prereqs: aws CLI, docker, valid AWS credentials with ECR push access.
# AgentCore Runtime requires linux/arm64; Docker BuildKit handles this
# automatically when you set --platform.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ECR_REPO:-foot-solutions-fs-assistant}"
IMAGE_TAG="${1:-${IMAGE_TAG:-latest}}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "▶ Build context: ${REPO_ROOT}"
echo "▶ Image:         ${IMAGE_URI}"

aws ecr describe-repositories \
  --repository-names "${ECR_REPO}" \
  --region "${AWS_REGION}" >/dev/null 2>&1 || {
  echo "✗ ECR repo '${ECR_REPO}' does not exist. Deploy FsAssistantStack first."
  exit 1
}

echo "▶ Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

echo "▶ Building ARM64 image..."
docker buildx build \
  --platform linux/arm64 \
  -f "${REPO_ROOT}/agents/fs-assistant/Dockerfile" \
  -t "${IMAGE_URI}" \
  --push \
  "${REPO_ROOT}"

echo "✓ Pushed ${IMAGE_URI}"
echo
echo "Next: deploy or update the AgentCore runtime to point at this image."
echo "  CDK does this automatically on the next \`cdk deploy FsAssistantStack\`."
