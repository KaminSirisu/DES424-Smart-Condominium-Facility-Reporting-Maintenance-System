import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { assetBucketName, g02Synthesizer } from '../lib/asset-staging.js';
import { ScfrmsDevStack } from '../lib/scfrms-dev-stack.js';

const env = { account: '528301714999', region: 'ap-southeast-1' };

function template(context: Record<string, string> = {}): Template {
  const app = new App({ context });
  return Template.fromStack(
    new ScfrmsDevStack(app, 'TestStack', {
      env,
      synthesizer: g02Synthesizer(),
    }),
  );
}

describe('G02 development stack', () => {
  it('uses a group-owned staging bucket without bootstrap roles', () => {
    const staging = Template.fromString(
      readFileSync(new URL('../asset-staging.json', import.meta.url), 'utf8'),
    );
    staging.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: assetBucketName,
      BucketEncryption: Match.anyValue(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    staging.resourceCountIs('AWS::IAM::Role', 0);

    const dev = template();
    dev.resourceCountIs('AWS::SSM::Parameter', 0);
    expect(dev.toJSON().Parameters?.BootstrapVersion).toBeUndefined();
  });

  it('matches the backend table keys, streams, and rate-limit TTL', () => {
    const t = template();
    t.resourceCountIs('AWS::DynamoDB::Table', 8);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'des424-g02-scfrms-dev-Tickets',
      KeySchema: [{ AttributeName: 'ticketId', KeyType: 'HASH' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'TeamOpenIndex' }),
        Match.objectLike({
          IndexName: 'TeamDoneIndex',
          KeySchema: [
            { AttributeName: 'teamDoneKey', KeyType: 'HASH' },
            { AttributeName: 'completedKey', KeyType: 'RANGE' },
          ],
        }),
        Match.objectLike({ IndexName: 'CreatedMonthIndex' }),
      ]),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'des424-g02-scfrms-dev-TicketEvents',
      KeySchema: [
        { AttributeName: 'ticketId', KeyType: 'HASH' },
        { AttributeName: 'eventKey', KeyType: 'RANGE' },
      ],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'des424-g02-scfrms-dev-RateLimits',
      KeySchema: [
        { AttributeName: 'limitKey', KeyType: 'HASH' },
        { AttributeName: 'windowStart', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('starts with health only and does not turn on workers before credentials exist', () => {
    const t = template();
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/health',
    });
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    expect(Object.keys(t.findResources('AWS::ECR::Repository'))).toHaveLength(
      0,
    );
  });

  it('requires a Bedrock model before enabling triage', () => {
    expect(() => template({ enableTriage: 'true' })).toThrow(
      'enableTriage=true requires -c bedrockModelId=<model ID>.',
    );
  });

  it('adds staff login and me routes with a generated signing secret only when enabled', () => {
    const t = template({ enableStaffAuth: 'true' });
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /v1/auth/staff/login',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/auth/staff/me',
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-stafflogin',
      Environment: {
        Variables: Match.objectLike({
          STAFF_JWT_SECRET_ARN: Match.anyValue(),
          STAFF_JWT_SECRET: Match.absent(),
        }),
      },
    });
  });

  it('adds staff and reporter ticket reads only with both auth contexts', () => {
    expect(() => template({ enableStaffTicketReads: 'true' })).toThrow(
      'enableStaffTicketReads=true requires enableStaffAuth=true.',
    );
    expect(() =>
      template({ enableStaffAuth: 'true', enableStaffTicketReads: 'true' }),
    ).toThrow('enableStaffTicketReads=true requires -c lineLoginChannelId');

    const t = template({
      enableStaffAuth: 'true',
      enableStaffTicketReads: 'true',
      lineLoginChannelId: '1234567890',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/tickets',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/tickets/{ticketId}',
    });
    for (const name of ['listtickets', 'getticket']) {
      t.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `des424-g02-scfrms-dev-${name}`,
        Environment: {
          Variables: Match.objectLike({
            LINE_LOGIN_CHANNEL_ID: '1234567890',
            STAFF_JWT_SECRET_ARN: Match.anyValue(),
            STAFF_JWT_SECRET: Match.absent(),
          }),
        },
      });
    }
    const readPolicies = Object.entries(
      t.findResources('AWS::IAM::Policy'),
    ).filter(([id]) => /^(ListTickets|GetTicket)ServiceRole/.test(id));
    expect(readPolicies).toHaveLength(2);
    const actions = readPolicies.flatMap(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (statement: { Action: string | string[] }) =>
          Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action],
      ),
    );
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions).toContain('dynamodb:Query');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:GetRecords');
    expect(actions).not.toContain('dynamodb:PutItem');
  });

  it('gates photo access and limits its thumbnail write permission', () => {
    expect(() => template({ enablePhotoAccess: 'true' })).toThrow(
      'enablePhotoAccess=true requires enableStaffAuth=true.',
    );
    expect(() =>
      template({ enablePhotoAccess: 'true', enableStaffAuth: 'true' }),
    ).toThrow('enablePhotoAccess=true requires -c lineLoginChannelId');

    const t = template({
      enablePhotoAccess: 'true',
      enableStaffAuth: 'true',
      lineLoginChannelId: '1234567890',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/tickets/{ticketId}/photos/{photoId}/access',
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-getphotoaccess',
      MemorySize: 512,
      Timeout: 30,
    });
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')).filter(
      ([id]) => /^GetPhotoAccessServiceRole/.test(id),
    );
    expect(policies).toHaveLength(1);
    const statements = policies[0][1].Properties.PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
      Condition?: { StringLike?: Record<string, string[]> };
    }[];
    const thumbnailWrite = statements.find(
      ({ Action }) => Action === 's3:PutObject',
    );
    expect(JSON.stringify(thumbnailWrite?.Resource)).toContain('/thumbnails/*');
    expect(JSON.stringify(thumbnailWrite?.Resource)).not.toContain(
      '/uploads/*',
    );
    const scopedList = statements.find(
      ({ Action }) => Action === 's3:ListBucket',
    );
    expect(scopedList?.Condition?.StringLike?.['s3:prefix']).toEqual([
      'uploads/*',
      'thumbnails/*',
    ]);
    const actions = statements.flatMap(({ Action }) => Action);
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions).toContain('dynamodb:Query');
    expect(actions).toContain('s3:GetObject');
    expect(actions).toContain('s3:PutObject');
    expect(actions).toContain('s3:ListBucket');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('s3:DeleteObject');
  });

  it('gates staff writes and grants only the tables and proof objects they need', () => {
    expect(() => template({ enableStaffTicketWrites: 'true' })).toThrow(
      'enableStaffTicketWrites=true requires enableStaffAuth=true.',
    );
    expect(() =>
      template({ enableStaffAuth: 'true', enableStaffTicketWrites: 'true' }),
    ).toThrow('enableStaffTicketWrites=true requires -c lineLoginChannelId');

    const t = template({
      enableStaffAuth: 'true',
      enableStaffTicketWrites: 'true',
      lineLoginChannelId: '1234567890',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowMethods: Match.arrayWith(['PATCH']),
      },
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PATCH /v1/tickets/{ticketId}/status',
    });
    for (const name of ['createupload', 'setticketstatus']) {
      t.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `des424-g02-scfrms-dev-${name}`,
        Environment: {
          Variables: Match.objectLike({
            STAFF_JWT_SECRET_ARN: Match.anyValue(),
            STAFF_JWT_SECRET: Match.absent(),
          }),
        },
      });
    }
    const writePolicies = Object.entries(
      t.findResources('AWS::IAM::Policy'),
    ).filter(([id]) => /^(CreateUpload|SetTicketStatus)ServiceRole/.test(id));
    expect(writePolicies).toHaveLength(2);
    const actions = writePolicies.flatMap(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (statement: { Action: string | string[] }) =>
          Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action],
      ),
    );
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions).toContain('dynamodb:UpdateItem');
    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('s3:GetObject');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:DeleteItem');
  });

  it('wires both stream workers and the ticket route when configured', () => {
    const t = template({
      lineLoginChannelId: '1234567890',
      enableTriage: 'true',
      bedrockModelId: 'example-model',
      enableNotifications: 'true',
      sesSenderEmail: 'verified@example.com',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /v1/tickets',
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /v1/uploads',
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-createupload',
      Environment: {
        Variables: Match.objectLike({
          LINE_LOGIN_CHANNEL_ID: '1234567890',
          UPLOAD_BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-triage',
      Timeout: 60,
    });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      MaximumRetryAttempts: 3,
      StartingPosition: 'LATEST',
    });
    const notifyPolicies = Object.entries(
      t.findResources('AWS::IAM::Policy'),
    ).filter(([id]) => id.startsWith('NotifyServiceRole'));
    const notifyActions = notifyPolicies.flatMap(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.flatMap(
        (statement: { Action: string | string[] }) =>
          Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action],
      ),
    );
    expect(notifyActions).toContain('dynamodb:Scan');
  });

  it('wires the complete API and scheduled SLA sweep only when enabled', () => {
    const t = template({
      lineLoginChannelId: '1234567890',
      enableStaffAuth: 'true',
      enableStaffTicketReads: 'true',
      enableStaffTicketWrites: 'true',
      enablePhotoAccess: 'true',
      enableExtendedApi: 'true',
      enableSlaSweep: 'true',
    });
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 24);
    t.resourceCountIs('AWS::DynamoDB::Table', 9);
    t.resourceCountIs('AWS::SecretsManager::Secret', 3);
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'des424-g02-scfrms-dev/mfa-encryption-key',
      GenerateSecretString: {
        PasswordLength: 43,
        ExcludePunctuation: true,
      },
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'des424-g02-scfrms-dev-AccountEvents',
      KeySchema: [
        { AttributeName: 'accountId', KeyType: 'HASH' },
        { AttributeName: 'eventKey', KeyType: 'RANGE' },
      ],
    });
    t.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
    });
    for (const routeKey of [
      'POST /v1/tickets/{ticketId}/reopen',
      'POST /v1/tickets/{ticketId}/merge',
      'PATCH /v1/tickets/{ticketId}/triage',
      'GET /v1/dashboard/summary',
      'POST /v1/auth/staff/mfa/verify',
      'PATCH /v1/staff-accounts/{accountId}',
    ]) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
      });
    }
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-reopenticket',
      Environment: {
        Variables: Match.objectLike({
          LINE_LOGIN_CHANNEL_ID: '1234567890',
          STAFF_JWT_SECRET_ARN: Match.absent(),
        }),
      },
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'des424-g02-scfrms-dev-mfaverify',
      Environment: {
        Variables: Match.objectLike({
          MFA_ENCRYPTION_KEY_ARN: Match.anyValue(),
          ACCOUNT_EVENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  }, 30000);
});
