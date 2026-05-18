#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FootSolutionsStack } from '../lib/foot-solutions-stack';

const app = new cdk.App();

new FootSolutionsStack(app, 'FootSolutionsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Foot Solutions Management Platform — Phase 1 MVP',
});
