import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client';
import { TicketEventRecord, TicketRecord } from '../tickets/types';

/**
 * DynamoDB access for the Ticket entity (single-table). Everything about one
 * ticket shares a partition, so one Query reads it all:
 *
 *   PK `TICKET#<id>` / SK `METADATA`                    the ticket
 *   PK `TICKET#<id>` / SK `REPORTER#<lineUserId>`       reporter association
 *       GSI2PK `REPORTER#<lineUserId>`, GSI2SK `CREATED#<createdAt>`
 *       — lists a reporter's tickets; a merged ticket carries one
 *       association per reporter.
 *   PK `TICKET#<id>` / SK `EVENT#<occurredAt>#<kind>`   audit event,
 *       time-ordered for paginated history.
 *
 * GSI1 (team queue) and GSI3 (status/deadline) are populated later, once a
 * ticket has a teamId and deadline. Keys are documented in
 * docs/database/README.md.
 */

type TicketItem = TicketRecord & {
  PK: string;
  SK: 'METADATA';
  entityType: 'TICKET';
};

type ReporterItem = {
  PK: string;
  SK: string;
  GSI2PK: string;
  GSI2SK: string;
  entityType: 'TICKET_REPORTER';
  ticketId: string;
  reporterLineUserId: string;
  associatedAt: string;
};

type EventItem = TicketEventRecord & {
  PK: string;
  SK: string;
  entityType: 'TICKET_EVENT';
};

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set.');
  }
  return name;
}

function ticketKey(ticketId: string): { PK: string; SK: 'METADATA' } {
  return { PK: `TICKET#${ticketId}`, SK: 'METADATA' };
}

function toItem(record: TicketRecord): TicketItem {
  return {
    ...record,
    ...ticketKey(record.id),
    entityType: 'TICKET',
  };
}

function toReporterItem(record: TicketRecord): ReporterItem {
  return {
    PK: `TICKET#${record.id}`,
    SK: `REPORTER#${record.reporterLineUserId}`,
    GSI2PK: `REPORTER#${record.reporterLineUserId}`,
    GSI2SK: `CREATED#${record.createdAt}`,
    entityType: 'TICKET_REPORTER',
    ticketId: record.id,
    reporterLineUserId: record.reporterLineUserId,
    associatedAt: record.createdAt,
  };
}

function toCreatedEventItem(record: TicketRecord): EventItem {
  return {
    PK: `TICKET#${record.id}`,
    SK: `EVENT#${record.createdAt}#TICKET_CREATED`,
    entityType: 'TICKET_EVENT',
    id: `${record.id}_created`,
    ticketId: record.id,
    kind: 'TICKET_CREATED',
    occurredAt: record.createdAt,
    actorType: 'REPORTER',
    toStatus: record.status,
    repairCycle: record.repairCycle,
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
 * Creates a new ticket together with its reporter association and its
 * TICKET_CREATED audit event, all-or-nothing. Fails with
 * TransactionCanceledException (reason ConditionalCheckFailed) if a ticket
 * with this id already exists — the caller uses this to detect an
 * Idempotency-Key collision and avoid writing a duplicate.
 */
export async function createTicket(record: TicketRecord): Promise<void> {
  const TableName = tableName();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: toItem(record),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        { Put: { TableName, Item: toReporterItem(record) } },
        { Put: { TableName, Item: toCreatedEventItem(record) } },
      ],
    }),
  );
}
