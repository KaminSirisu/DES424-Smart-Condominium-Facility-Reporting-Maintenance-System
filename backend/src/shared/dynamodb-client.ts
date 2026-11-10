import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Shared DynamoDB client, module-scoped so Lambda reuses it across warm
 * invocations instead of reconnecting every call.
 *
 * Table design: one table per entity, as proposed in SCFRMS-28 (see
 * docs/database/dynamodb-access-patterns.md). Table names come from
 * environment variables, listed in shared/tables.ts.
 */

const client = new DynamoDBClient({
  region: process.env.AWS_REGION,
  // Only set for local development against DynamoDB Local; omitted (undefined)
  // in real AWS, where the SDK resolves the real regional endpoint.
  endpoint: process.env.DYNAMODB_ENDPOINT || undefined,
});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
