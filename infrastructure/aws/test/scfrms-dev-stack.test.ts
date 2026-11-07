import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ScfrmsDevStack } from '../lib/scfrms-dev-stack.js';

function template(context: Record<string, string> = {}): Template {
  const app = new App({ context });
  return Template.fromStack(
    new ScfrmsDevStack(app, 'TestStack', {
      env: { account: '528301714999', region: 'ap-southeast-1' },
    }),
  );
}

describe('G02 development stack', () => {
  it('matches the backend table keys, streams, and rate-limit TTL', () => {
    const t = template();
    t.resourceCountIs('AWS::DynamoDB::Table', 8);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'des424-g02-scfrms-dev-Tickets',
      KeySchema: [{ AttributeName: 'ticketId', KeyType: 'HASH' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'TeamOpenIndex' }),
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
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      MaximumRetryAttempts: 3,
      StartingPosition: 'LATEST',
    });
  });
});
