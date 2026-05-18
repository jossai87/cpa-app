"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FootSolutionsStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const nodejs = __importStar(require("aws-cdk-lib/aws-lambda-nodejs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const apigwv2authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
class FootSolutionsStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ── 0. Cost-allocation tags (apply to every taggable resource in the stack) ──
        aws_cdk_lib_1.Tags.of(this).add('Project', 'foot-solutions-platform');
        aws_cdk_lib_1.Tags.of(this).add('Environment', 'production');
        aws_cdk_lib_1.Tags.of(this).add('Owner', 'flowermound@footsolutions.com');
        aws_cdk_lib_1.Tags.of(this).add('CostCenter', 'foot-solutions-flowermound');
        aws_cdk_lib_1.Tags.of(this).add('ManagedBy', 'cdk');
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
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
        });
        // Hosted UI domain
        userPool.addDomain('HostedUIDomain', {
            cognitoDomain: { domainPrefix: 'foot-solutions-app' },
        });
        aws_cdk_lib_1.Tags.of(userPool).add('Component', 'auth');
        // ── 2. S3 Static Bucket (created before CloudFront to avoid circular dep) ──
        const staticBucket = new s3.Bucket(this, 'StaticBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
            enforceSSL: true,
        });
        aws_cdk_lib_1.Tags.of(staticBucket).add('Component', 'frontend');
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
                    ttl: aws_cdk_lib_1.Duration.seconds(0),
                },
                {
                    httpStatus: 404,
                    responseHttpStatus: 200,
                    responsePagePath: '/index.html',
                    ttl: aws_cdk_lib_1.Duration.seconds(0),
                },
            ],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        });
        aws_cdk_lib_1.Tags.of(distribution).add('Component', 'frontend');
        const cloudfrontDomain = `https://${distribution.distributionDomainName}`;
        // ── 4. Cognito User Pool Client (now that CloudFront domain is known) ──
        const userPoolClient = userPool.addClient('WebClient', {
            userPoolClientName: 'foot-solutions-web-client',
            generateSecret: false,
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
                callbackUrls: [cloudfrontDomain + '/'],
                logoutUrls: [cloudfrontDomain + '/'],
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
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });
        aws_cdk_lib_1.Tags.of(table).add('Component', 'data');
        // ── 5b. Docs Bucket — private, for uploaded CPA documents ────────
        const docsBucket = new s3.Bucket(this, 'DocsBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
            lifecycleRules: [
                {
                    // Auto-delete uploaded documents after 90 days
                    expiration: aws_cdk_lib_1.Duration.days(90),
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
        aws_cdk_lib_1.Tags.of(docsBucket).add('Component', 'documents');
        // ── 6. Lambda Extension Layer (Secrets Manager) ──────────────────
        const secretsExtensionLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'SecretsExtension', 'arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:11');
        // ── 7. taxHandler Lambda ─────────────────────────────────────────
        const taxFn = new nodejs.NodejsFunction(this, 'TaxHandler', {
            functionName: 'foot-solutions-tax-handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: '../lambda/tax/index.ts',
            handler: 'handler',
            projectRoot: '../lambda',
            depsLockFilePath: '../lambda/package-lock.json',
            timeout: aws_cdk_lib_1.Duration.seconds(30),
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
        aws_cdk_lib_1.Tags.of(taxFn).add('Component', 'ai-tax-analysis');
        // Grant DynamoDB read/write
        table.grantReadWriteData(taxFn);
        // Grant Bedrock InvokeModel on:
        //  1. The US cross-region inference profile (what the Lambda calls)
        //  2. All underlying foundation model ARNs the profile may route to
        //     (cross-region inference fans out to the model in any US region)
        taxFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'BedrockInvokeModel',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:us-east-1:*:inference-profile/us.amazon.nova-2-lite-v1:0',
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0',
                'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0',
                'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0',
            ],
        }));
        // ── 8. credentialHandler Lambda ──────────────────────────────────
        const credFn = new nodejs.NodejsFunction(this, 'CredentialHandler', {
            functionName: 'foot-solutions-credential-handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: '../lambda/credential/index.ts',
            handler: 'handler',
            projectRoot: '../lambda',
            depsLockFilePath: '../lambda/package-lock.json',
            timeout: aws_cdk_lib_1.Duration.seconds(10),
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
        aws_cdk_lib_1.Tags.of(credFn).add('Component', 'credentials');
        // Grant Secrets Manager GetSecretValue + PutSecretValue on credential path
        credFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerCredentials',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
            resources: ['arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/credentials/*'],
        }));
        // Grant ListSecrets (resource-level restrictions not supported for this action)
        credFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerList',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:ListSecrets'],
            resources: ['*'],
        }));
        // ── 9. documentHandler Lambda ────────────────────────────────────
        const docFn = new nodejs.NodejsFunction(this, 'DocumentHandler', {
            functionName: 'foot-solutions-document-handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: '../lambda/document/index.ts',
            handler: 'handler',
            projectRoot: '../lambda',
            depsLockFilePath: '../lambda/package-lock.json',
            timeout: aws_cdk_lib_1.Duration.seconds(60),
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
        aws_cdk_lib_1.Tags.of(docFn).add('Component', 'ai-extraction');
        // Grant S3 read/write/delete on the docs bucket
        docsBucket.grantReadWrite(docFn);
        docsBucket.grantDelete(docFn);
        // Grant DynamoDB read/write for document metadata persistence
        table.grantReadWriteData(docFn);
        // Grant Bedrock InvokeModel — Lite (cheap, fast) AND Pro (smarter for complex docs)
        docFn.addToRolePolicy(new iam.PolicyStatement({
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
        }));
        // ── 9b. heartlandHandler Lambda ──────────────────────────────────
        const heartlandFn = new nodejs.NodejsFunction(this, 'HeartlandHandler', {
            functionName: 'foot-solutions-heartland-handler',
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: '../lambda/heartland/index.ts',
            handler: 'handler',
            projectRoot: '../lambda',
            depsLockFilePath: '../lambda/package-lock.json',
            timeout: aws_cdk_lib_1.Duration.seconds(60),
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
        aws_cdk_lib_1.Tags.of(heartlandFn).add('Component', 'pos-integration');
        // Grant DynamoDB read for cache reads (writes happen in sync Lambda)
        table.grantReadData(heartlandFn);
        // Grant Secrets Manager read for the Heartland API token only
        heartlandFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'HeartlandTokenRead',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                'arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/heartland/*',
            ],
        }));
        // ── 9c. heartlandSync Lambda — scheduled background sync ─────────
        const heartlandSyncFn = new nodejs.NodejsFunction(this, 'HeartlandSyncHandler', {
            functionName: 'foot-solutions-pos-sync',
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: '../lambda/heartland-sync/index.ts',
            handler: 'handler',
            projectRoot: '../lambda',
            depsLockFilePath: '../lambda/package-lock.json',
            timeout: aws_cdk_lib_1.Duration.minutes(5),
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
        aws_cdk_lib_1.Tags.of(heartlandSyncFn).add('Component', 'pos-integration');
        // Sync Lambda needs read+write for cache, secrets read for the token
        table.grantReadWriteData(heartlandSyncFn);
        heartlandSyncFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'HeartlandSyncTokenRead',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                'arn:aws:secretsmanager:us-east-1:*:secret:foot-solutions/heartland/*',
            ],
        }));
        // Allow user-facing handler to invoke the sync Lambda asynchronously
        heartlandSyncFn.grantInvoke(heartlandFn);
        // Schedule the sync to run every 6 hours
        new events.Rule(this, 'HeartlandSyncSchedule', {
            schedule: events.Schedule.rate(aws_cdk_lib_1.Duration.hours(6)),
            targets: [new targets.LambdaFunction(heartlandSyncFn)],
            description: 'Run Heartland POS sync every 6 hours',
        });
        // ── 10. API Gateway HTTP API ──────────────────────────────────────
        const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
            apiName: 'foot-solutions-api',
            description: 'Foot Solutions Management Platform HTTP API',
            corsPreflight: {
                allowOrigins: [cloudfrontDomain],
                allowMethods: [
                    apigwv2.CorsHttpMethod.GET,
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.PUT,
                    apigwv2.CorsHttpMethod.DELETE,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: ['Authorization', 'Content-Type'],
                maxAge: aws_cdk_lib_1.Duration.seconds(300),
            },
        });
        aws_cdk_lib_1.Tags.of(httpApi).add('Component', 'api');
        // JWT Authorizer backed by Cognito User Pool
        const jwtAuthorizer = new apigwv2authorizers.HttpJwtAuthorizer('CognitoAuthorizer', `https://cognito-idp.us-east-1.amazonaws.com/${userPool.userPoolId}`, {
            jwtAudience: [userPoolClient.userPoolClientId],
            authorizerName: 'CognitoJwtAuthorizer',
        });
        // Lambda integrations
        const taxIntegration = new apigwv2integrations.HttpLambdaIntegration('TaxIntegration', taxFn);
        const credIntegration = new apigwv2integrations.HttpLambdaIntegration('CredIntegration', credFn);
        const docIntegration = new apigwv2integrations.HttpLambdaIntegration('DocIntegration', docFn);
        const heartlandIntegration = new apigwv2integrations.HttpLambdaIntegration('HeartlandIntegration', heartlandFn);
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
        // Credential routes
        httpApi.addRoutes({
            path: '/credentials',
            methods: [apigwv2.HttpMethod.GET],
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
        // ── 11. Stack Outputs ─────────────────────────────────────────────
        new aws_cdk_lib_1.CfnOutput(this, 'ApiUrl', {
            exportName: 'FootSolutions-ApiUrl',
            value: httpApi.apiEndpoint,
            description: 'API Gateway HTTP API endpoint URL',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolId', {
            exportName: 'FootSolutions-UserPoolId',
            value: userPool.userPoolId,
            description: 'Cognito User Pool ID',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolClientId', {
            exportName: 'FootSolutions-UserPoolClientId',
            value: userPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'CloudFrontUrl', {
            exportName: 'FootSolutions-CloudFrontUrl',
            value: cloudfrontDomain,
            description: 'CloudFront distribution URL',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'StaticBucketName', {
            exportName: 'FootSolutions-StaticBucketName',
            value: staticBucket.bucketName,
            description: 'S3 static assets bucket name',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionId', {
            exportName: 'FootSolutions-DistributionId',
            value: distribution.distributionId,
            description: 'CloudFront distribution ID',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'CognitoHostedUiUrl', {
            exportName: 'FootSolutions-CognitoHostedUiUrl',
            value: `https://foot-solutions-app.auth.us-east-1.amazoncognito.com`,
            description: 'Cognito Hosted UI base domain — append /login?client_id=<ClientId>&response_type=code&scope=openid+email&redirect_uri=<CloudFrontUrl>/',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DocsBucketName', {
            exportName: 'FootSolutions-DocsBucketName',
            value: docsBucket.bucketName,
            description: 'S3 bucket for uploaded CPA documents',
        });
    }
}
exports.FootSolutionsStack = FootSolutionsStack;
