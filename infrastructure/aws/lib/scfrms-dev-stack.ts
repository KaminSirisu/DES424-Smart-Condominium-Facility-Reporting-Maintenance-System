import path from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import { aws_apigatewayv2 as apigwv2 } from 'aws-cdk-lib';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { aws_dynamodb as ddb } from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { aws_lambda_event_sources as sources } from 'aws-cdk-lib';
import { aws_lambda_nodejs as nodejs } from 'aws-cdk-lib';
import { aws_logs as logs } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_secretsmanager as secrets } from 'aws-cdk-lib';
import { aws_sqs as sqs } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const prefix = 'des424-g02-scfrms-dev';
const root = path.resolve(import.meta.dirname, '../../..');
const backend = path.join(root, 'backend/src');

function stringContext(scope: Construct, key: string): string | undefined {
  const value = scope.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enabled(scope: Construct, key: string): boolean {
  return scope.node.tryGetContext(key) === 'true';
}

export class ScfrmsDevStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    if (this.region !== 'ap-southeast-1' || this.account !== '528301714999') {
      throw new Error(
        'The G02 development stack targets account 528301714999 in ap-southeast-1 only.',
      );
    }
    Tags.of(this).add('Project', 'SCFRMS');
    Tags.of(this).add('CourseGroup', 'DES424-G02');
    Tags.of(this).add('Environment', 'dev');

    const table = (
      name: string,
      partitionKey: string,
      sortKey?: { name: string; type: ddb.AttributeType },
      stream?: ddb.StreamViewType,
      ttl?: string,
    ): ddb.Table =>
      new ddb.Table(this, name, {
        tableName: `${prefix}-${name}`,
        partitionKey: { name: partitionKey, type: ddb.AttributeType.STRING },
        sortKey,
        billingMode: ddb.BillingMode.PAY_PER_REQUEST,
        encryption: ddb.TableEncryption.AWS_MANAGED,
        stream,
        timeToLiveAttribute: ttl,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
        removalPolicy: RemovalPolicy.RETAIN,
      });

    const tickets = table(
      'Tickets',
      'ticketId',
      undefined,
      ddb.StreamViewType.NEW_IMAGE,
    );
    tickets.addGlobalSecondaryIndex({
      indexName: 'TeamOpenIndex',
      partitionKey: { name: 'teamStatusKey', type: ddb.AttributeType.STRING },
      sortKey: { name: 'createdKey', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });
    tickets.addGlobalSecondaryIndex({
      indexName: 'CreatedMonthIndex',
      partitionKey: { name: 'createdMonth', type: ddb.AttributeType.STRING },
      sortKey: { name: 'createdKey', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    const reporters = table('TicketReporters', 'ticketId', {
      name: 'reporterLineUserId',
      type: ddb.AttributeType.STRING,
    });
    reporters.addGlobalSecondaryIndex({
      indexName: 'ReporterTicketsIndex',
      partitionKey: {
        name: 'reporterLineUserId',
        type: ddb.AttributeType.STRING,
      },
      sortKey: { name: 'associatedKey', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    const photos = table('TicketPhotos', 'ticketId', {
      name: 'photoId',
      type: ddb.AttributeType.STRING,
    });
    const events = table(
      'TicketEvents',
      'ticketId',
      {
        name: 'eventKey',
        type: ddb.AttributeType.STRING,
      },
      ddb.StreamViewType.NEW_IMAGE,
    );
    const accounts = table('Accounts', 'username');
    const teams = table('Teams', 'teamId');
    const notifications = table('Notifications', 'ticketId', {
      name: 'notificationKey',
      type: ddb.AttributeType.STRING,
    });
    const rateLimits = table(
      'RateLimits',
      'limitKey',
      {
        name: 'windowStart',
        type: ddb.AttributeType.NUMBER,
      },
      undefined,
      'expiresAt',
    );

    const uploads = new s3.Bucket(this, 'Uploads', {
      bucketName: `${prefix}-uploads-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
      cors: [
        {
          allowedOrigins: [
            'https://main.d1zgqd6jel45cl.amplifyapp.com',
            ...([stringContext(this, 'adminOrigin')].filter(
              Boolean,
            ) as string[]),
          ],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ['*'],
          maxAge: 300,
        },
      ],
    });

    // A generated value is only a placeholder. Replace it with the real token
    // in Secrets Manager before enabling the notification stream mapping.
    const lineToken = new secrets.Secret(this, 'LineChannelAccessToken', {
      secretName: `${prefix}/line-channel-access-token`,
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const tableEnv = {
      TICKETS_TABLE_NAME: tickets.tableName,
      TICKET_REPORTERS_TABLE_NAME: reporters.tableName,
      TICKET_PHOTOS_TABLE_NAME: photos.tableName,
      TICKET_EVENTS_TABLE_NAME: events.tableName,
      ACCOUNTS_TABLE_NAME: accounts.tableName,
      TEAMS_TABLE_NAME: teams.tableName,
      NOTIFICATIONS_TABLE_NAME: notifications.tableName,
      RATE_LIMITS_TABLE_NAME: rateLimits.tableName,
      UPLOAD_BUCKET_NAME: uploads.bucketName,
    };

    const fn = (
      name: string,
      entry: string,
      environment: Record<string, string>,
    ): nodejs.NodejsFunction => {
      const functionName = `${prefix}-${name.toLowerCase()}`;
      return new nodejs.NodejsFunction(this, name, {
        functionName,
        entry: path.join(backend, entry),
        handler: 'handler',
        depsLockFilePath: path.join(root, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: Duration.seconds(20),
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          minify: true,
          sourceMap: true,
          sourcesContent: false,
          bundleAwsSDK: true,
        },
        environment,
      });
    };

    const health = fn('Health', 'handlers/health.ts', {});
    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      corsPreflight: {
        allowOrigins: [
          'https://main.d1zgqd6jel45cl.amplifyapp.com',
          ...([stringContext(this, 'adminOrigin')].filter(Boolean) as string[]),
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        exposeHeaders: ['retry-after'],
      },
    });
    // Coarse account-wide protection against accidental traffic spikes. The
    // per-IP requirement needs a separate WAF-compatible front door.
    const defaultStage = api.defaultStage?.node
      .defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 10,
      throttlingBurstLimit: 20,
    };
    api.addRoutes({
      path: '/v1/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', health),
    });

    const lineChannelId = stringContext(this, 'lineLoginChannelId');
    if (lineChannelId) {
      const upload = fn('CreateUpload', 'uploads/reporter-upload.ts', {
        ...tableEnv,
        LINE_LOGIN_CHANNEL_ID: lineChannelId,
      });
      uploads.grantPut(upload, 'uploads/*');
      api.addRoutes({
        path: '/v1/uploads',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration(
          'CreateUploadIntegration',
          upload,
        ),
      });

      const create = fn('CreateTicket', 'tickets/create-ticket.ts', {
        ...tableEnv,
        LINE_LOGIN_CHANNEL_ID: lineChannelId,
      });
      for (const t of [tickets, reporters, photos, events, rateLimits])
        t.grantReadWriteData(create);
      uploads.grantRead(create, 'uploads/*');
      api.addRoutes({
        path: '/v1/tickets',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration(
          'CreateTicketIntegration',
          create,
        ),
      });
    }

    if (enabled(this, 'enableTriage')) {
      const modelId = stringContext(this, 'bedrockModelId');
      if (!modelId)
        throw new Error(
          'enableTriage=true requires -c bedrockModelId=<model ID>.',
        );
      const triage = fn('Triage', 'triage/triage-handler.ts', {
        ...tableEnv,
        BEDROCK_MODEL_ID: modelId,
      });
      triage.addEventSource(
        new sources.DynamoEventSource(tickets, {
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 1,
          reportBatchItemFailures: true,
          retryAttempts: 3,
          onFailure: new sources.SqsDlq(
            new sqs.Queue(this, 'TriageFailures', {
              queueName: `${prefix}-triage-failures`,
              retentionPeriod: Duration.days(14),
              encryption: sqs.QueueEncryption.SQS_MANAGED,
            }),
          ),
        }),
      );
      for (const t of [tickets, photos]) t.grantReadData(triage);
      for (const t of [tickets, events]) t.grantWriteData(triage);
      uploads.grantRead(triage, 'uploads/*');
      triage.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'rekognition:DetectLabels'],
          resources: ['*'],
        }),
      );
    }

    if (enabled(this, 'enableNotifications')) {
      const sender = stringContext(this, 'sesSenderEmail');
      if (!sender)
        throw new Error(
          'enableNotifications=true requires -c sesSenderEmail=<verified address>.',
        );
      const notify = fn('Notify', 'notifications/notification-handler.ts', {
        ...tableEnv,
        SES_SENDER_EMAIL: sender,
        LINE_CHANNEL_ACCESS_TOKEN_SECRET_ARN: lineToken.secretArn,
        LIFF_URL: stringContext(this, 'liffUrl') ?? '',
        ADMIN_DASHBOARD_URL: stringContext(this, 'adminOrigin') ?? '',
      });
      notify.addEventSource(
        new sources.DynamoEventSource(events, {
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 1,
          reportBatchItemFailures: true,
          retryAttempts: 3,
          onFailure: new sources.SqsDlq(
            new sqs.Queue(this, 'NotificationFailures', {
              queueName: `${prefix}-notification-failures`,
              retentionPeriod: Duration.days(14),
              encryption: sqs.QueueEncryption.SQS_MANAGED,
            }),
          ),
        }),
      );
      for (const t of [tickets, photos, reporters, teams])
        t.grantReadData(notify);
      notifications.grantReadWriteData(notify);
      lineToken.grantRead(notify);
      notify.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
        }),
      );
    }

    new CfnOutput(this, 'ApiBaseUrl', { value: `${api.apiEndpoint}/v1` });
    new CfnOutput(this, 'UploadBucketName', { value: uploads.bucketName });
    new CfnOutput(this, 'LineTokenSecretName', { value: lineToken.secretName });
    new CfnOutput(this, 'TableNamePrefix', { value: prefix });
  }
}
