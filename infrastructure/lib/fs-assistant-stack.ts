import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
  aws_cloudwatch as cloudwatch,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_logs as logs,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { CfnResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Props for FsAssistantStack.
 *
 * `tableName` is required so the AgentCore execution role can be scoped
 * to a single DynamoDB table (the IAM Matrix in design.md §IAM Matrix
 * specifies `FootSolutionsApp` only).
 */
export interface FsAssistantStackProps extends StackProps {
  /** DynamoDB table name the Sales/Inbox sub-agents read. */
  tableName: string;
  /**
   * Account-id-aware ARN of the table — passed in rather than re-derived
   * so the consuming stack picks the right region.
   */
  tableArn: string;
  /**
   * Image tag to deploy. Defaults to `latest`. Override on a non-prod
   * synth to deploy a known-good build (e.g. `dev-2025-01-15`).
   */
  imageTag?: string;
  /**
   * AgentCore Runtime qualifier (alias). Defaults to `DEFAULT`.
   * Use a non-default qualifier (e.g. `dev`) to deploy a parallel
   * runtime alongside production.
   */
  runtimeQualifier?: string;
}

/**
 * FS Assistant Orchestrator infrastructure (Phase 1).
 *
 * Provisions:
 *   - ECR repository for the Strands TypeScript agent container
 *     (`agents/fs-assistant`).
 *   - AgentCore Runtime resource (`AWS::BedrockAgentCore::Runtime`)
 *     pointing at the ECR image.
 *   - AgentCore execution role with the IAM Matrix entries from
 *     design.md §IAM Matrix:
 *       • bedrock:InvokeModel for Haiku 4.5 + Sonnet 4.6 inference
 *         profiles + foundation-model ARNs
 *       • Cohere multilingual embed for kb_semantic_search
 *       • DynamoDB read/write on the FootSolutionsApp table
 *       • secretsmanager:GetSecretValue scoped to the gmail/ + tavily/
 *         secret prefixes
 *       • s3vectors QueryVectors for the inbox vector index
 *       • CloudWatch Logs + X-Ray + cloudwatch:PutMetricData
 *
 * The edge Lambda + `/assistant/chat` route + chat-history `?type=all`
 * extension are NOT in this stack — they live in `foot-solutions-stack.ts`
 * where the existing API Gateway HTTP API is defined (Task 12.1).
 *
 * Subsequent task adds:
 *   - Task 19.1: CloudWatch dashboard + alarms
 *   - Task 21.1: Composite soak alarm
 */
export class FsAssistantStack extends Stack {
  /** ARN of the AgentCore Runtime; the edge Lambda's env var. */
  public readonly runtimeArn: string;

  /** Name of the ECR repo (used by the build-and-push script). */
  public readonly repositoryName: string;

  /** AgentCore execution role — exposed for cross-stack policy attachments. */
  public readonly agentCoreRole: iam.Role;

  constructor(scope: Construct, id: string, props: FsAssistantStackProps) {
    super(scope, id, props);

    const imageTag = props.imageTag ?? 'latest';
    const qualifier = props.runtimeQualifier ?? 'DEFAULT';

    // CDK context flag — set to `true` only AFTER the first image has
    // been pushed to ECR. Without it the AgentCore runtime resource is
    // skipped, so the stack can deploy the ECR repo + execution role
    // first (chicken-and-egg: the runtime requires an image at create
    // time).
    //
    //   cdk synth FsAssistantStack -c enableFsAssistantRuntime=true
    //
    const enableRuntime =
      this.node.tryGetContext('enableFsAssistantRuntime') === true ||
      this.node.tryGetContext('enableFsAssistantRuntime') === 'true';

    // ── 1. ECR repository ──────────────────────────────────────────
    const repo = new ecr.Repository(this, 'FsAssistantRepo', {
      repositoryName: 'foot-solutions-fs-assistant',
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Keep the 10 most recent images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });
    Tags.of(repo).add('Component', 'fs-assistant');
    this.repositoryName = repo.repositoryName;

    const imageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${repo.repositoryName}:${imageTag}`;

    // ── 2. AgentCore execution role ────────────────────────────────
    //
    // The role is shared by the orchestrator + Sales_Agent + Inbox_Agent
    // (they all live in the same container). Tool-list scoping inside
    // the container enforces the per-agent separation of duty.
    const role = new iam.Role(this, 'AgentCoreExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: 'Execution role for the FS Assistant AgentCore Runtime',
    });
    this.agentCoreRole = role;

    // ECR image pull (required for AgentCore to start the container).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRImageAccess',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [repo.repositoryArn],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRTokenAccess',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    // CloudWatch Logs (per AgentCore HTTP protocol contract).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsCreateGroup',
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsList',
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsWrite',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      })
    );

    // X-Ray (AgentCore native observability).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'XRayAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch metrics in the bedrock-agentcore namespace.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreCloudWatchMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' },
        },
      })
    );

    // Bedrock model invocation — Haiku 4.5 (orchestrator) + Sonnet 4.6
    // (sub-agents) inference profiles + foundation model ARNs + Cohere
    // embed for kb_semantic_search.
    //
    // We grant on a wildcard family-name pattern (`*claude-sonnet-4-6*`)
    // because Strands' BedrockModel resolves the inference-profile model
    // id to the foundation-model ARN at request time, and the foundation
    // model ARN does NOT carry the version suffix that the inference
    // profile id does (e.g. inference profile is
    // `global.anthropic.claude-sonnet-4-6` but the FM ARN is
    // `anthropic.claude-sonnet-4-6` without version pin). Both forms
    // need to be in the policy.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // Foundation model ARNs (with and without version suffix).
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*`,
          // Inference profiles (cross-region) — global.* and us.*.
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-haiku-4-5*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6*`,
          // Cohere multilingual embed (kb_semantic_search).
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      })
    );

    // DynamoDB — scoped to the FootSolutionsApp table only.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDBTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
        ],
        resources: [props.tableArn, `${props.tableArn}/index/*`],
      })
    );

    // Secrets Manager — Gmail OAuth + Tavily key.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GmailOAuthSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:foot-solutions/gmail/*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:foot-solutions/tavily/*`,
        ],
      })
    );

    // S3 Vectors — query the inbox vector index.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3VectorsQuery',
        effect: iam.Effect.ALLOW,
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
        resources: ['*'],
      })
    );

    // Lambda invoke — for the on-demand Heartland today-only sync that
    // refresh_sales_now triggers from the Sales sub-agent.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeHeartlandSync',
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:foot-solutions-pos-sync`,
        ],
      })
    );

    // ── 3. Pre-create the CloudWatch log group ─────────────────────
    //
    // AgentCore writes to /aws/bedrock-agentcore/runtimes/<runtime-id>-<qualifier>
    // automatically; we don't pre-create it because the runtime id is
    // generated by the service. Retention is set on the log group when
    // it appears via a separate observability stack (Task 19.1).
    void logs; // keep import live for future use

    // ── 4. AgentCore Runtime (L1 / CfnResource) ────────────────────
    //
    // CDK does not yet have an L2 construct for
    // `AWS::BedrockAgentCore::Runtime`, so we use the L1 CfnResource.
    // The `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`
    // points at the ECR image we just provisioned.
    //
    // The runtime is only provisioned when `-c enableFsAssistantRuntime=true`
    // is set so the first deploy can stand up ECR + role without an image.
    if (enableRuntime) {
      const runtime = new CfnResource(this, 'FsAssistantRuntime', {
        type: 'AWS::BedrockAgentCore::Runtime',
        properties: {
          AgentRuntimeName: 'fs_assistant',
          Description:
            'FS Assistant — unified Foot Solutions assistant (orchestrator + Sales + Inbox sub-agents)',
          AgentRuntimeArtifact: {
            ContainerConfiguration: {
              ContainerUri: imageUri,
            },
          },
          RoleArn: role.roleArn,
          NetworkConfiguration: {
            NetworkMode: 'PUBLIC',
          },
          ProtocolConfiguration: 'HTTP',
          EnvironmentVariables: {
            AWS_REGION: this.region,
            TABLE_NAME: props.tableName,
            OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
            HEARTLAND_SYNC_FN: 'foot-solutions-pos-sync',
          },
        },
      });
      runtime.node.addDependency(repo);
      runtime.node.addDependency(role);

      // The L1 resource exposes Arn as a CFN attribute.
      this.runtimeArn = runtime.getAtt('AgentRuntimeArn').toString();
    } else {
      this.runtimeArn =
        '__fs-assistant-runtime-not-yet-deployed__ ' +
        '(deploy with -c enableFsAssistantRuntime=true after the image is pushed)';
    }

    // ── 5. Outputs ─────────────────────────────────────────────────
    new CfnOutput(this, 'RuntimeArn', {
      value: this.runtimeArn,
      description: 'AgentCore Runtime ARN — used as FS_ASSISTANT_RUNTIME_ARN env var on the edge Lambda',
      exportName: `${this.stackName}-RuntimeArn`,
    });
    new CfnOutput(this, 'RuntimeQualifier', {
      value: qualifier,
      description: 'AgentCore Runtime qualifier (alias) — passed to InvokeAgentRuntime',
    });
    new CfnOutput(this, 'EcrRepositoryUri', {
      value: repo.repositoryUri,
      description: 'ECR repository URI for the FS Assistant container',
    });
    new CfnOutput(this, 'EcrRepositoryName', {
      value: repo.repositoryName,
      description: 'ECR repository name (used by build-and-push.sh)',
    });
    new CfnOutput(this, 'AgentCoreRoleArn', {
      value: role.roleArn,
      description: 'AgentCore execution role ARN',
    });

    // ── 6. CloudWatch dashboard + alarms (Task 19.1) ───────────────
    //
    // Custom metrics emitted by the edge Lambda (lambda/assistant/index.ts):
    //   FsAssistant / AssistantRouteCount{route}
    //   FsAssistant / OrchestratorTurnLatencyMs
    //   FsAssistant / SubAgentUnavailable
    //
    // Per-sub-agent latency (`SubAgentLatencyMs`) is emitted from
    // inside the AgentCore container in a follow-up; the dashboard
    // tile is created here with empty data so the layout is stable.
    const NAMESPACE = 'FsAssistant';

    const routeMetric = (route: 'sales' | 'inbox' | 'both' | 'general') =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: 'AssistantRouteCount',
        dimensionsMap: { route },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });

    const latencyP50 = new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: 'OrchestratorTurnLatencyMs',
      statistic: 'p50',
      period: Duration.minutes(5),
    });
    const latencyP95 = new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: 'OrchestratorTurnLatencyMs',
      statistic: 'p95',
      period: Duration.minutes(5),
    });
    const latencyP99 = new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: 'OrchestratorTurnLatencyMs',
      statistic: 'p99',
      period: Duration.minutes(5),
    });

    const subAgentUnavailable = new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: 'SubAgentUnavailable',
      statistic: 'Sum',
      period: Duration.minutes(5),
    });

    const dashboard = new cloudwatch.Dashboard(this, 'FsAssistantDashboard', {
      dashboardName: 'FsAssistant',
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Routing distribution (5-min buckets)',
        width: 24,
        stacked: true,
        left: [
          routeMetric('sales'),
          routeMetric('inbox'),
          routeMetric('both'),
          routeMetric('general'),
        ],
      })
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Orchestrator latency (ms)',
        width: 24,
        left: [latencyP50, latencyP95, latencyP99],
      })
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Sub-agent unavailability events (5-min sum)',
        width: 24,
        left: [subAgentUnavailable],
      })
    );

    // Alarms — design.md §Alarms (CloudWatch).
    const orchestratorLatencyAlarm = new cloudwatch.Alarm(
      this,
      'OrchestratorLatencyP95Alarm',
      {
        alarmName: 'FsAssistant-OrchestratorLatencyP95',
        alarmDescription:
          'Orchestrator p95 latency exceeded 8s for 5 minutes — investigate sub-agent timeouts or Bedrock throttling.',
        metric: latencyP95,
        threshold: 8000,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      }
    );
    const subAgentUnavailableAlarm = new cloudwatch.Alarm(
      this,
      'SubAgentUnavailableAlarm',
      {
        alarmName: 'FsAssistant-SubAgentUnavailable',
        alarmDescription:
          'More than 5 sub-agent unavailability events per 5-minute window — investigate sub-agent health.',
        metric: subAgentUnavailable,
        threshold: 5,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      }
    );

    // ── 7. Soak window composite alarm (Task 21.1) ─────────────────
    //
    // Phase 5 / 14-day soak watchdog. Breaches if EITHER alarm above
    // (latency p95 > 8s OR sub-agent unavailability > 5/5min) fires
    // at any point during the soak window. Used as the gate for
    // promoting from "soak" → "stable" and removing legacy /pos/chat
    // and /gmail/chat (Req 10.2). The 14-day wait happens outside
    // CDK; this construct just emits the alarm.
    //
    // We pass the Alarm constructs directly (not fromAlarmName lookups)
    // so CFN sees the dependency edge and orders the composite-alarm
    // create after the underlying alarms — without this, the composite
    // alarm fails on first deploy because CFN validates that the
    // referenced alarms already exist.
    const soakAlarm = new cloudwatch.CompositeAlarm(
      this,
      'FsAssistantSoakHealth',
      {
        compositeAlarmName: 'FsAssistantSoakHealth',
        alarmDescription:
          'Composite soak watchdog — breaches if any FS Assistant alarm fires during the 14-day soak window (Phase 5).',
        alarmRule: cloudwatch.AlarmRule.anyOf(
          cloudwatch.AlarmRule.fromAlarm(
            orchestratorLatencyAlarm,
            cloudwatch.AlarmState.ALARM
          ),
          cloudwatch.AlarmRule.fromAlarm(
            subAgentUnavailableAlarm,
            cloudwatch.AlarmState.ALARM
          )
        ),
      }
    );
    soakAlarm.node.addDependency(orchestratorLatencyAlarm);
    soakAlarm.node.addDependency(subAgentUnavailableAlarm);

    new CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description:
        'CloudWatch dashboard for FS Assistant routing + latency + errors',
    });

    // Suppress lint of unused custom_resources import — reserved for
    // Task 19.1 (CloudWatch dashboards) which uses cr.AwsCustomResource.
    void cr;
    void Duration;
  }
}
