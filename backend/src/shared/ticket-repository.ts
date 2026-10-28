import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client';
import { TicketRecord } from '../tickets/types';

/**
 * DynamoDB access for the Ticket entity (single-table — see
 * docs/database/README.md for the full key scheme).
 *
 * Keys for a Ticket item:
 *   PK: `TICKET#<ticketId>`
 *   SK: `METADATA`
 *   GSI2PK / GSI2SK: `REPORTER#<lineUserId>` / `CREATED#<createdAt>`
 *     — lets a reporter list their own tickets (GSI2 is shared with
 *       other entity types too; here it exists only for that query).
 *
 * GSI1 (team queue) and GSI3 (status-wide) are populated later, once a
 * ticket has a teamId/meaningful status — not set on creation.
 */

type TicketItem = TicketRecord & {
  PK: string;
  SK: string;
  GSI2PK: string;
  GSI2SK: string;
  entityType: 'TICKET';
};

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set.');
  }
  return name;
}

function ticketKey(ticketId: string): { PK: string; SK: string } {
  return { PK: `TICKET#${ticketId}`, SK: 'METADATA' };
}

function toItem(record: TicketRecord): TicketItem {
  return {
    ...record,
    ...ticketKey(record.id),
    GSI2PK: `REPORTER#${record.reporterLineUserId}`,
    GSI2SK: `CREATED#${record.createdAt}`,
    entityType: 'TICKET',
  };
}

export async function getTicket(
  ticketId: string,
): Promise<TicketRecord | null> {
  const result = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: ticketKey(ticketId) }),
  );
  return (result.Item as TicketRecord | undefined) ?? null;
}

/**
 * Creates a new ticket. Fails (ConditionalCheckFailedException) if a
 * ticket with this id already exists — the caller uses this to detect an
 * Idempotency-Key collision and avoid writing a duplicate.
 */
export async function createTicket(record: TicketRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName(),
      Item: toItem(record),
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}
