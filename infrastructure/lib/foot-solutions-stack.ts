import { Duration, RemovalPolicy, CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

// Custom domain config — manually-provisioned ACM cert in us-east-1
const CUSTOM_DOMAIN = 'fsmanagementsystem.com';
const CUSTOM_DOMAIN_ALT = `www.${CUSTOM_DOMAIN}`;
const HOSTED_ZONE_ID = 'Z0341623D3YSWQ21OYVP';
const ACM_CERT_ARN = 'arn:aws:acm:us-east-1:558985210319:certificate/619356b6-ac75-494b-8f9a-6ba46e2386be';

export class FootSolutionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ── 0. Cost-allocation tags (apply to every taggable resource in the stack) ──
    Tags.of(this).add('Project', 'foot-solutions-platform');
    Tags.of(this).add('Environment', 'production');
    Tags.of(this).add('Owner', 'flowermound@footsolutions.com');
    Tags.of(this).add('CostCenter', 'foot-solutions-flowermound');
    Tags.of(this).add('ManagedBy', 'cdk');

    // ── 1. Cognito User Pool ─────────────────────────────────────────
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'foot-solutions-user-pool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Hosted UI domain
    userPool.addDomain('HostedUIDomain', {
      cognitoDomain: { domainPrefix: 'foot-solutions-app' },
    });
    Tags.of(userPool).add('Component', 'auth');

    // ── 2. S3 Static Bucket (created before CloudFront to avoid circular dep) ──
    const staticBucket = new s3.Bucket(this, 'StaticBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
    });
    Tags.of(staticBucket).add('Component', 'frontend');

    // ── 3. CloudFront OAC + Distribution ────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'OAC for Foot Solutions static bucket',
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      additionalBehaviors: {
        '*.js': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
        '*.css': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
        '*.woff': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false,
        },
        '*.woff2': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false,
        },
        '*.png': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false,
        },
        '*.svg': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
        '*.ico': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
            originAccessControl: oac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false,
        },
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames: [CUSTOM_DOMAIN, CUSTOM_DOMAIN_ALT],
      certificate: acm.Certificate.fromCertificateArn(this, 'CustomDomainCert', ACM_CERT_ARN),
    });
    Tags.of(distribution).add('Component', 'frontend');

    // ── 3b. Route 53 alias records → CloudFront ──────────────────────
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: CUSTOM_DOMAIN,
    });
    new route53.ARecord(this, 'AliasApex', {
      zone: hostedZone,
      recordName: CUSTOM_DOMAIN,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AliasApexAAAA', {
      zone: hostedZone,
      recordName: CUSTOM_DOMAIN,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.ARecord(this, 'AliasWww', {
      zone: hostedZone,
      recordName: CUSTOM_DOMAIN_ALT,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AliasWwwAAAA', {
      zone: hostedZone,
      recordName: CUSTOM_DOMAIN_ALT,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    const cloudfrontDomain = `https://${CUSTOM_DOMAIN}`;

    // ── 4. Cognito User Pool Client (now that CloudFront domain is known) ──
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'foot-solutions-web-client',
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [
          `https://${CUSTOM_DOMAIN}/callback`,
          `https://${CUSTOM_DOMAIN_ALT}/callback`,
        ],
        logoutUrls: [
          `https://${CUSTOM_DOMAIN}/`,
          `https://${CUSTOM_DOMAIN}/login`,
          `https://${CUSTOM_DOMAIN_ALT}/`,
          `https://${CUSTOM_DOMAIN_ALT}/login`,
        ],
      },
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // ── 5. DynamoDB Table ────────────────────────────────────────────
    const table = new dynamodb.Table(this, 'AppTable', {
      tableName: 'FootSolutionsApp',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Optional `ttl` attribute on items — DynamoDB auto-deletes them
      // within 48h of expiry. Used by the Gmail cache for the rolling
      // 365-day window. Items without `ttl` are unaffected.
      timeToLiveAttribute: 'ttl',
    });
    Tags.of(table).add('Component', 'data');

    // ── 5b. Docs Bucket — private, for uploaded CPA documents ────────
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Auto-delete uploaded documents after 90 days
          expiration: Duration.days(90),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'], // Will be tightened post-deploy via CloudFront origin
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
    Tags.of(docsBucket).add('Component', 'documents');

    // ── 6. Lambda Extension Layer (Secrets Manager) ──────────────────
    const secretsExtensionLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'SecretsExtension',
      'arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:11'
    );

    // ── 7. taxHandler Lambda ─────────────────────────────────────────
    const taxFn = new nodejs.NodejsFunction(this, 'TaxHandler', {
      functionName: 'foot-solutions-tax-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/tax/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: 'us.amazon.nova-2-lite-v1:0',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Handles tax calculation, Bedrock invocation, and DynamoDB session persistence',
    });
    Tags.of(taxFn).add('Component', 'ai-tax-analysis');

    // Grant DynamoDB read/write
    table.grantReadWriteData(taxFn);

    // Grant Bedrock InvokeModel on:
    //  1. The US cross-region inference profile (what the Lambda calls)
    //  2. All underlying foundation model ARNs the profile may route to
    //     (cross-region inference fans out to the model in any US region)
    taxFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0',
        ],
      })
    );

    // ── 8. credentialHandler Lambda ──────────────────────────────────
    const credFn = new nodejs.NodejsFunction(this, 'CredentialHandler', {
      functionName: 'foot-solutions-credential-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/credential/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.seconds(10),
      memorySize: 128,
      layers: [secretsExtensionLayer],
      environment: {
        SECRET_PATH_PREFIX: 'foot-solutions/credentials/',
        PARAMETERS_SECRETS_EXTENSION_CACHE_ENABLED: 'true',
        PARAMETERS_SECRETS_EXTENSION_CACHE_SIZE: '10',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Handles Secrets Manager CRUD for the Credential Vault',
    });
    Tags.of(credFn).add('Component', 'credentials');

    // Grant Secrets Manager GetSecretValue + PutSecretValue + CreateSecret on credential path
    credFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerCredentials',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:CreateSecret'],
        resources: ['arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/credentials/*'],
      })
    );

    // Grant ListSecrets (resource-level restrictions not supported for this action)
    credFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerList',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      })
    );

    // ── 9. documentHandler Lambda ────────────────────────────────────
    const docFn = new nodejs.NodejsFunction(this, 'DocumentHandler', {
      functionName: 'foot-solutions-document-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/document/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        DOCS_BUCKET: docsBucket.bucketName,
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: 'us.amazon.nova-2-lite-v1:0',
        BEDROCK_PRO_MODEL_ID: 'us.amazon.nova-pro-v1:0',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Handles document upload (pre-signed URLs) and Bedrock-powered field extraction',
    });
    Tags.of(docFn).add('Component', 'ai-extraction');

    // Grant S3 read/write/delete on the docs bucket
    docsBucket.grantReadWrite(docFn);
    docsBucket.grantDelete(docFn);

    // Grant DynamoDB read/write for document metadata persistence
    table.grantReadWriteData(docFn);

    // Grant Bedrock InvokeModel — Lite (cheap, fast) AND Pro (smarter for complex docs)
    docFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModelForExtraction',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          // Nova 2 Lite
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0',
          // Nova Pro
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
        ],
      })
    );

    // ── 9b. heartlandHandler Lambda ──────────────────────────────────
    const heartlandFn = new nodejs.NodejsFunction(this, 'HeartlandHandler', {
      functionName: 'foot-solutions-heartland-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/heartland/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.seconds(60),
      memorySize: 256,
      layers: [secretsExtensionLayer],
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        SYNC_FUNCTION_NAME: 'foot-solutions-pos-sync',
        PARAMETERS_SECRETS_EXTENSION_CACHE_ENABLED: 'true',
        PARAMETERS_SECRETS_EXTENSION_CACHE_SIZE: '10',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Heartland Retail POS user-facing read-only handler — reads from cache only',
    });
    Tags.of(heartlandFn).add('Component', 'pos-integration');

    // Grant DynamoDB read for cache reads (writes happen in sync Lambda)
    table.grantReadData(heartlandFn);
    // Allow writing the synthetic "POS Import" document record so it shows up
    // in the user's Documents sidebar / CPA package after each import.
    table.grantWriteData(heartlandFn);

    // Grant Secrets Manager read for the Heartland API token only
    heartlandFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'HeartlandTokenRead',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          'arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/heartland/*',
        ],
      })
    );

    // ── 9c. heartlandSync Lambda — scheduled background sync ─────────
    const heartlandSyncFn = new nodejs.NodejsFunction(this, 'HeartlandSyncHandler', {
      functionName: 'foot-solutions-pos-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/heartland-sync/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.minutes(5),
      memorySize: 1024,
      layers: [secretsExtensionLayer],
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        PARAMETERS_SECRETS_EXTENSION_CACHE_ENABLED: 'true',
        PARAMETERS_SECRETS_EXTENSION_CACHE_SIZE: '10',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Heartland POS background sync — runs every 6h via EventBridge, populates DynamoDB cache',
    });
    Tags.of(heartlandSyncFn).add('Component', 'pos-integration');

    // Sync Lambda needs read+write for cache, secrets read for the token
    table.grantReadWriteData(heartlandSyncFn);
    heartlandSyncFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'HeartlandSyncTokenRead',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          'arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/heartland/*',
        ],
      })
    );

    // Allow user-facing handler to invoke the sync Lambda asynchronously
    heartlandSyncFn.grantInvoke(heartlandFn);

    // Schedule the sync to run every 6 hours
    new events.Rule(this, 'HeartlandSyncSchedule', {
      schedule: events.Schedule.rate(Duration.hours(6)),
      targets: [new targets.LambdaFunction(heartlandSyncFn)],
      description: 'Run Heartland POS sync every 6 hours',
    });

    // ── 10. API Gateway HTTP API ──────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'foot-solutions-api',
      description: 'Foot Solutions Management Platform HTTP API',
      corsPreflight: {
        allowOrigins: [
          `https://${CUSTOM_DOMAIN}`,
          `https://${CUSTOM_DOMAIN_ALT}`,
          // CloudFront distribution domain — used when custom domain isn't yet
          // pointed at CloudFront or during development/testing.
          `https://${distribution.distributionDomainName}`,
          // Local dev
          'http://localhost:3000',
          'http://localhost:5173',
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: Duration.seconds(300),
      },
    });
    Tags.of(httpApi).add('Component', 'api');

    // JWT Authorizer backed by Cognito User Pool
    const jwtAuthorizer = new apigwv2authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.us-east-1.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        authorizerName: 'CognitoJwtAuthorizer',
      }
    );

    // Lambda integrations
    const taxIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'TaxIntegration',
      taxFn
    );
    const credIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'CredIntegration',
      credFn
    );
    const docIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'DocIntegration',
      docFn
    );
    const heartlandIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'HeartlandIntegration',
      heartlandFn
    );

    // Tax routes
    httpApi.addRoutes({
      path: '/tax/calculate',
      methods: [apigwv2.HttpMethod.POST],
      integration: taxIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/tax/history',
      methods: [apigwv2.HttpMethod.GET],
      integration: taxIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/tax/history/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration: taxIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/tax/history/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: taxIntegration,
      authorizer: jwtAuthorizer,
    });

    // Document routes
    httpApi.addRoutes({
      path: '/documents/upload-url',
      methods: [apigwv2.HttpMethod.POST],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/extract',
      methods: [apigwv2.HttpMethod.POST],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/bda-job',
      methods: [apigwv2.HttpMethod.POST],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents',
      methods: [apigwv2.HttpMethod.GET],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/{id}/download-url',
      methods: [apigwv2.HttpMethod.GET],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/{id}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/{id}/flagged/{index}/resolve',
      methods: [apigwv2.HttpMethod.POST],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/documents/register-supporting',
      methods: [apigwv2.HttpMethod.POST],
      integration: docIntegration,
      authorizer: jwtAuthorizer,
    });

    // Credential routes
    httpApi.addRoutes({
      path: '/credentials',
      methods: [apigwv2.HttpMethod.GET],
      integration: credIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/credentials',
      methods: [apigwv2.HttpMethod.POST],
      integration: credIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/credentials/{id}/copy',
      methods: [apigwv2.HttpMethod.POST],
      integration: credIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/credentials/{id}',
      methods: [apigwv2.HttpMethod.PUT],
      integration: credIntegration,
      authorizer: jwtAuthorizer,
    });

    // POS routes (Heartland integration)
    httpApi.addRoutes({
      path: '/pos/dashboard',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/sales',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/import-tax-defaults',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/analytics',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/inventory',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/staff',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/sync-status',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/sync',
      methods: [apigwv2.HttpMethod.POST],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/purchasing',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/purchasing/orders/{id}/lines',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/vendor-health',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/reporting',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/insights',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/vendor-settings',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/vendor-settings',
      methods: [apigwv2.HttpMethod.PUT],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/admin/settings',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/admin/settings',
      methods: [apigwv2.HttpMethod.PUT],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });

    // ── 10b. Chat Lambda (Sales & Revenue AI assistant) ───────────────
    const chatFn = new nodejs.NodejsFunction(this, 'ChatHandler', {
      functionName: 'foot-solutions-chat-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/chat/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        BEDROCK_MODEL_ID: 'us.amazon.nova-pro-v1:0',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Sales & Revenue AI chatbot — Bedrock tool use with DynamoDB data access',
    });
    Tags.of(chatFn).add('Component', 'ai-chat');

    // Grant DynamoDB read for context fetching
    table.grantReadData(chatFn);

    // Grant Bedrock InvokeModel for Nova 2 Lite
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ChatBedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          // Nova Pro (primary)
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
          // Nova 2 Lite (fallback)
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0',
        ],
      })
    );

    const chatIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'ChatIntegration',
      chatFn
    );

    httpApi.addRoutes({
      path: '/pos/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: chatIntegration,
      authorizer: jwtAuthorizer,
    });

    // The Sales chatbot can also read Gmail (for vendor / inbox context).
    // Same secret prefix the daily-report Lambda uses.
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ChatGmailSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/gmail/*`,
        ],
      })
    );

    // ── 10b1. Gmail Analysis Lambda (analyze + chat over inbox) ──────
    const gmailAnalysisFn = new nodejs.NodejsFunction(this, 'GmailAnalysisHandler', {
      functionName: 'foot-solutions-gmail-analysis',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/gmail-analysis/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      // 5 minutes — analyze runs against ~1400 cached msgs and may take
      // 2-3 minutes on a cold start with multiple tool-call rounds.
      // The synchronous API Gateway path returns in <1s; longer runs are
      // self-invoked async (InvocationType: Event) to bypass the 30s API GW
      // integration timeout.
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        // Claude Haiku 4.5 — primary analysis model. Same tool-use and
        // structured-output quality as Sonnet for this workload at ~3×
        // lower latency and ~3× lower cost. Override with BEDROCK_MODEL_ID
        // to swap models without redeploying.
        BEDROCK_MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Gmail Analysis: structured digest + agentic chat grounded in the owner\'s inbox',
    });
    Tags.of(gmailAnalysisFn).add('Component', 'ai-gmail-analysis');

    // DynamoDB read+write for the cached analysis item (sk=GMAIL#ANALYSIS#LATEST)
    // and the per-message Gmail cache (sk=GMAIL#MSG/THREAD/VENDOR/KIND…).
    table.grantReadWriteData(gmailAnalysisFn);

    // Bedrock InvokeModel — Claude Sonnet 4.6 (primary) + 4.5 + Nova Pro fallbacks
    gmailAnalysisFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailAnalysisBedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // Claude Haiku 4.5 (primary)
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
          // Claude Sonnet 4.6 (fallback / legacy)
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-6',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
          // Claude Sonnet 4.5 (fallback)
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
          // Nova Pro (fallback)
          'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
        ],
      })
    );

    // Secrets Manager read on Gmail OAuth client + refresh token + Tavily API key
    gmailAnalysisFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailAnalysisGmailSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/gmail/*`,
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/tavily/*`,
        ],
      })
    );

    // Allow self-invocation (async background analyze runs that bypass the
    // 30s API Gateway integration timeout). Using addToRolePolicy with a
    // wildcard ARN avoids the circular CFN dependency that grantInvoke()
    // creates when a function references itself.
    gmailAnalysisFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailAnalysisSelfInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:us-east-1:${this.account}:function:foot-solutions-gmail-analysis`,
        ],
      })
    );

    const gmailAnalysisIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'GmailAnalysisIntegration',
      gmailAnalysisFn
    );

    httpApi.addRoutes({
      path: '/gmail/analyze',
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: gmailAnalysisIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/gmail/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: gmailAnalysisIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/gmail/cache-stats',
      methods: [apigwv2.HttpMethod.GET],
      integration: gmailAnalysisIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/gmail/discover-vendor-accounts',
      methods: [apigwv2.HttpMethod.POST],
      integration: gmailAnalysisIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/pos/daily-highlights',
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: gmailAnalysisIntegration,
      authorizer: jwtAuthorizer,
    });

    // ── 10b1.5. S3 Vectors index + SQS queue + embed Lambda ──────────
    //
    // This block stands up the semantic-search backbone for the chatbot:
    //   • S3 Vectors bucket + index (1024-dim, cosine, Cohere v3 multilingual)
    //   • SQS queue + DLQ for embed jobs (gmail-sync → gmail-embed)
    //   • Gmail Embed Lambda (SQS → Cohere → PutVectors)
    //   • Wires gmail-sync to enqueue and gmail-analysis to query

    // S3 Vectors bucket + index
    // Vector bucket name must be globally unique within an account+region,
    // 3–63 chars, lowercase + digits + hyphens.
    const VECTOR_INDEX_NAME = 'gmail-messages';
    const vectorBucketName = `fs-gmail-vectors-${this.account}`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'GmailVectorBucket', {
      vectorBucketName,
      encryptionConfiguration: { sseType: 'AES256' },
    });
    const vectorIndex = new s3vectors.CfnIndex(this, 'GmailVectorIndex', {
      vectorBucketName,
      indexName: VECTOR_INDEX_NAME,
      dataType: 'float32',
      dimension: 1024, // Cohere v3 multilingual returns 1024 floats
      distanceMetric: 'cosine',
      metadataConfiguration: {
        // Body preview is preserved alongside the vector so search hits
        // can be summarized without a follow-up DDB read. Marked
        // non-filterable since it's free-text (large + not useful as a filter).
        nonFilterableMetadataKeys: ['bodyPreview'],
      },
    });
    vectorIndex.addDependency(vectorBucket);

    const vectorBucketArn = `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}`;
    const vectorIndexArn = `${vectorBucketArn}/index/${VECTOR_INDEX_NAME}`;

    // SQS: gmail-sync → gmail-embed
    const gmailEmbedDLQ = new sqs.Queue(this, 'GmailEmbedDLQ', {
      queueName: 'foot-solutions-gmail-embed-dlq',
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    Tags.of(gmailEmbedDLQ).add('Component', 'ai-gmail-analysis');

    const gmailEmbedQueue = new sqs.Queue(this, 'GmailEmbedQueue', {
      queueName: 'foot-solutions-gmail-embed',
      // Visibility timeout must exceed the embed Lambda timeout (60s).
      visibilityTimeout: Duration.minutes(2),
      retentionPeriod: Duration.days(7),
      enforceSSL: true,
      deadLetterQueue: { queue: gmailEmbedDLQ, maxReceiveCount: 3 },
    });
    Tags.of(gmailEmbedQueue).add('Component', 'ai-gmail-analysis');

    // Gmail Embed Lambda — SQS-triggered
    const gmailEmbedFn = new nodejs.NodejsFunction(this, 'GmailEmbedHandler', {
      functionName: 'foot-solutions-gmail-embed',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/gmail-embed/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.minutes(1),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        VECTOR_BUCKET_NAME: vectorBucketName,
        VECTOR_INDEX_NAME,
        EMBED_MODEL_ID: 'cohere.embed-multilingual-v3',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Embeds Gmail messages with Cohere v3 multilingual and writes to S3 Vectors',
    });
    Tags.of(gmailEmbedFn).add('Component', 'ai-gmail-analysis');

    // Read cached message bodies
    table.grantReadData(gmailEmbedFn);

    // Bedrock InvokeModel — Cohere v3 multilingual (us-east-1 in-region only)
    gmailEmbedFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailEmbedBedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      })
    );

    // S3 Vectors PutVectors on the index
    gmailEmbedFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailEmbedVectorWrite',
        effect: iam.Effect.ALLOW,
        actions: ['s3vectors:PutVectors', 's3vectors:GetIndex'],
        resources: [vectorBucketArn, vectorIndexArn],
      })
    );

    // SQS event source — partial batch failure reporting so a single bad
    // message doesn't fail the whole batch.
    gmailEmbedFn.addEventSource(
      new lambdaEventSources.SqsEventSource(gmailEmbedQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(10),
        reportBatchItemFailures: true,
      })
    );

    // Wire gmail-analysis to query the index (Cohere embed + S3 Vectors query)
    gmailAnalysisFn.addEnvironment('VECTOR_BUCKET_NAME', vectorBucketName);
    gmailAnalysisFn.addEnvironment('VECTOR_INDEX_NAME', VECTOR_INDEX_NAME);
    gmailAnalysisFn.addEnvironment('EMBED_MODEL_ID', 'cohere.embed-multilingual-v3');
    gmailAnalysisFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailAnalysisEmbedQuery',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      })
    );
    gmailAnalysisFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailAnalysisVectorQuery',
        effect: iam.Effect.ALLOW,
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors', 's3vectors:GetIndex'],
        resources: [vectorBucketArn, vectorIndexArn],
      })
    );

    // ── 10b2. Gmail Sync Lambda (backfill + daily incremental) ───────
    const gmailSyncFn = new nodejs.NodejsFunction(this, 'GmailSyncHandler', {
      functionName: 'foot-solutions-gmail-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/gmail-sync/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      // Backfill of 6 months of mail can take several minutes — Gmail API
      // is the bottleneck (1 request per message body fetch).
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Gmail incremental + backfill sync into DynamoDB cache (TTL 365 days)',
    });
    Tags.of(gmailSyncFn).add('Component', 'gmail-sync');

    // Read+write for cache items + sync state
    table.grantReadWriteData(gmailSyncFn);

    // Read Gmail OAuth secrets
    gmailSyncFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GmailSyncGmailSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/gmail/*`,
        ],
      })
    );

    // Wire gmail-sync to enqueue embed jobs (write side of the KB)
    gmailSyncFn.addEnvironment('EMBED_QUEUE_URL', gmailEmbedQueue.queueUrl);
    gmailEmbedQueue.grantSendMessages(gmailSyncFn);

    // EventBridge cron — daily at 06:00 UTC ≈ 1am Central (incremental sync)
    new events.Rule(this, 'GmailSyncDailySchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '6', day: '*', month: '*', year: '*' }),
      targets: [
        new targets.LambdaFunction(gmailSyncFn, {
          event: events.RuleTargetInput.fromObject({ mode: 'incremental' }),
        }),
      ],
      description: 'Daily incremental Gmail sync (~1am Central)',
    });

    // On-demand: POST /gmail/sync routes through the same Lambda
    const gmailSyncIntegration = new apigwv2integrations.HttpLambdaIntegration(
      'GmailSyncIntegration',
      gmailSyncFn
    );
    httpApi.addRoutes({
      path: '/gmail/sync',
      methods: [apigwv2.HttpMethod.POST],
      integration: gmailSyncIntegration,
      authorizer: jwtAuthorizer,
    });

    // ── 10c. Daily Report Lambda (sends nightly briefing email) ──────
    const dailyReportFn = new nodejs.NodejsFunction(this, 'DailyReportHandler', {
      functionName: 'foot-solutions-daily-report',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../lambda/daily-report/index.ts',
      handler: 'handler',
      projectRoot: '../lambda',
      depsLockFilePath: '../lambda/package-lock.json',
      timeout: Duration.minutes(2),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        OWNER_USER_ID: '94989478-c051-7005-9033-3d722963c59b',
        // Default to Claude Sonnet 4.5 (no extra access required).
        // Switch to 'us.anthropic.claude-opus-4-7' after enabling marketplace
        // access at console.aws.amazon.com/bedrock → Model access.
        BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        FROM_ADDRESS: 'notifications@fsmanagementsystem.com',
        TO_ADDRESS: 'flowermound@footsolutions.com',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Daily sales briefing email — Bedrock Claude + SES',
    });
    Tags.of(dailyReportFn).add('Component', 'ai-daily-report');

    // Grant DynamoDB read+write (read sales data, write email history)
    table.grantReadWriteData(dailyReportFn);

    // Grant Bedrock InvokeModel for Claude family — covers Sonnet 4.5 and
    // Opus 4.7 so you can switch model IDs without redeploying.
    dailyReportFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DailyReportBedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // Inference profiles (region-bound + global)
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-opus-4-7',
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-opus-4-7',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-opus-4-5-20251101-v1:0',
          // Foundation model ARNs the profiles fan out to
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-7',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-5-20251101-v1:0',
        ],
      })
    );

    // Grant SES SendEmail from the verified domain
    dailyReportFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DailyReportSesSend',
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [
          `arn:aws:ses:us-east-1:${this.account}:identity/fsmanagementsystem.com`,
        ],
      })
    );

    // Grant Secrets Manager read for Gmail OAuth credentials + refresh token
    // and the Tavily API key (used for daily-highlights-style enrichment).
    // The secrets are created manually (one-time bootstrap) and named:
    //   foot-solutions/gmail/oauth-client    — { client_id, client_secret }
    //   foot-solutions/gmail/refresh-token   — { refresh_token, email }
    //   foot-solutions/tavily/api-key        — { apiKey }
    dailyReportFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DailyReportSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/gmail/*`,
          `arn:aws:secretsmanager:us-east-1:${this.account}:secret:foot-solutions/tavily/*`,
        ],
      })
    );

    // Wire daily-report into the same S3 Vectors KB the chatbot uses, so
    // briefings can pull semantic email matches (kb_semantic_search tool).
    dailyReportFn.addEnvironment('VECTOR_BUCKET_NAME', vectorBucketName);
    dailyReportFn.addEnvironment('VECTOR_INDEX_NAME', VECTOR_INDEX_NAME);
    dailyReportFn.addEnvironment('EMBED_MODEL_ID', 'cohere.embed-multilingual-v3');
    dailyReportFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DailyReportEmbedQuery',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      })
    );
    dailyReportFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DailyReportVectorQuery',
        effect: iam.Effect.ALLOW,
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors', 's3vectors:GetIndex'],
        resources: [vectorBucketArn, vectorIndexArn],
      })
    );

    // Schedule: every day at ~22:00 America/Chicago (10 PM Central).
    // EventBridge cron is UTC. 03:00 UTC ≈ 10 PM CST / 9 PM CDT (close enough year-round).
    new events.Rule(this, 'DailyReportSchedule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '3',
        day: '*',
        month: '*',
        year: '*',
      }),
      targets: [new targets.LambdaFunction(dailyReportFn)],
      description: 'Trigger daily sales briefing email at ~10 PM Central',
    });

    // Allow heartland handler to invoke the daily-report Lambda for test-email route
    dailyReportFn.grantInvoke(heartlandFn);
    heartlandFn.addEnvironment('DAILY_REPORT_FUNCTION_NAME', dailyReportFn.functionName);

    // ── 10d. New API routes for admin email feed + test send ─────────
    httpApi.addRoutes({
      path: '/admin/emails',
      methods: [apigwv2.HttpMethod.GET],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/admin/test-email',
      methods: [apigwv2.HttpMethod.POST],
      integration: heartlandIntegration,
      authorizer: jwtAuthorizer,
    });

    // ── 11. Stack Outputs ─────────────────────────────────────────────
    new CfnOutput(this, 'ApiUrl', {
      exportName: 'FootSolutions-ApiUrl',
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API endpoint URL',
    });

    new CfnOutput(this, 'UserPoolId', {
      exportName: 'FootSolutions-UserPoolId',
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      exportName: 'FootSolutions-UserPoolClientId',
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new CfnOutput(this, 'CloudFrontUrl', {
      exportName: 'FootSolutions-CloudFrontUrl',
      value: cloudfrontDomain,
      description: 'CloudFront distribution URL',
    });

    new CfnOutput(this, 'StaticBucketName', {
      exportName: 'FootSolutions-StaticBucketName',
      value: staticBucket.bucketName,
      description: 'S3 static assets bucket name',
    });

    new CfnOutput(this, 'DistributionId', {
      exportName: 'FootSolutions-DistributionId',
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new CfnOutput(this, 'CognitoHostedUiUrl', {
      exportName: 'FootSolutions-CognitoHostedUiUrl',
      value: `https://foot-solutions-app.auth.us-east-1.amazoncognito.com`,
      description: 'Cognito Hosted UI base domain — append /login?client_id=<ClientId>&response_type=code&scope=openid+email&redirect_uri=<CloudFrontUrl>/',
    });

    new CfnOutput(this, 'DocsBucketName', {
      exportName: 'FootSolutions-DocsBucketName',
      value: docsBucket.bucketName,
      description: 'S3 bucket for uploaded CPA documents',
    });
  }
}
