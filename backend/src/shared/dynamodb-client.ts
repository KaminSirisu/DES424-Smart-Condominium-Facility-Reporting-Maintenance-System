import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Shared DynamoDB client, module-scoped so Lambda reuses it across warm
 * invocations instead of reconnecting every call.
 *
 * Table design: single-table. One table (`TABLE_NAME`) holds every entity
 * (Ticket now; Account, Team, etc. as those modules are built), each
 * distinguished by a generic `PK`/`SK` key pair plus an `entityType`
 * attribute, with generic GSIs (`GSI1`..`GSI3`) reused across entity types
 * for their alternate access patterns. See docs/database/README.md for
 * the full key scheme.
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
