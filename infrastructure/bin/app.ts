#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FootSolutionsStack } from '../lib/foot-solutions-stack';
import { FsAssistantStack } from '../lib/fs-assistant-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

new FootSolutionsStack(app, 'FootSolutionsStack', {
  env,
  description: 'Foot Solutions Management Platform — Phase 1 MVP',
});

// FS Assistant Orchestrator (Phase 1) — separate stack so its lifecycle
// (build/push/deploy of the AgentCore Runtime container) is decoupled
// from the main app stack. The runtime resource itself is gated behind
// the `enableFsAssistantRuntime` CDK context flag — see the stack's
// constructor for the two-stage deploy workflow:
//
//   1. cdk deploy FsAssistantStack
//      → creates ECR repo + execution role only
//   2. ./agents/fs-assistant/scripts/build-and-push.sh
//      → builds the ARM64 image and pushes to ECR
//   3. cdk deploy FsAssistantStack -c enableFsAssistantRuntime=true
//      → provisions the AgentCore Runtime against the pushed image
//
// The runtime ARN output is consumed by the `assistantEdgeFn` Lambda's
// `FS_ASSISTANT_RUNTIME_ARN` env var (Task 12.1 — added in a follow-up
// CDK change inside FootSolutionsStack).
new FsAssistantStack(app, 'FsAssistantStack', {
  env,
  description: 'FS Assistant — Bedrock AgentCore Runtime + ECR + execution role',
  tableName: 'FootSolutionsApp',
  tableArn: `arn:aws:dynamodb:${env.region}:${env.account ?? '*'}:table/FootSolutionsApp`,
  imageTag:
    typeof app.node.tryGetContext('imageTag') === 'string'
      ? (app.node.tryGetContext('imageTag') as string)
      : undefined,
});
