import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client';
import { Priority, TicketEventRecord, TicketRecord } from '../tickets/types';

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
 * GSI1 (team queue: `TEAM#<teamId>` / `DEADLINE#<deadlineAt>`) is set by
 * applyTriage once a ticket is assigned; GSI3 (status) is still to come.
 * Keys are documented in docs/database/README.md.
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

export interface TriageUpdate {
  category: string;
  suggestedPriority: Priority;
  priority: Priority;
  teamId: string;
  deadlineAt: string;
  slaPolicyVersion: number;
  /** Time of this update; also the audit event's occurredAt. */
  now: string;
}

/**
 * Applies a validated triage result: RECEIVED -> ASSIGNED, sets category,
 * priority, team and deadline, bumps `version`, and adds the team-queue
 * index keys (GSI1) — all in one transaction with a TRIAGED audit event.
 *
 * Only succeeds if the ticket is still RECEIVED at `expectedVersion`.
 * Otherwise it fails with TransactionCanceledException (reason
 * ConditionalCheckFailed), so a duplicate triage run changes nothing.
 */
export async function applyTriage(
  ticketId: string,
  expectedVersion: number,
  update: TriageUpdate,
): Promise<void> {
  const TableName = tableName();
  const event: EventItem = {
    PK: `TICKET#${ticketId}`,
    SK: `EVENT#${update.now}#TRIAGED`,
    entityType: 'TICKET_EVENT',
    id: `${ticketId}_triaged`,
    ticketId,
    kind: 'TRIAGED',
    occurredAt: update.now,
    actorType: 'SYSTEM',
    fromStatus: 'RECEIVED',
    toStatus: 'ASSIGNED',
    toPriority: update.priority,
    toTeamId: update.teamId,
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName,
            Key: ticketKey(ticketId),
            ConditionExpression: '#status = :received AND #version = :version',
            UpdateExpression:
              'SET #status = :assigned, category = :category, ' +
              'suggestedPriority = :suggested, priority = :priority, ' +
              'teamId = :teamId, deadlineAt = :deadlineAt, ' +
              'slaPolicyVersion = :policy, triagedAt = :now, ' +
              'updatedAt = :now, #version = #version + :one, ' +
              'GSI1PK = :gsi1pk, GSI1SK = :gsi1sk',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#version': 'version',
            },
            ExpressionAttributeValues: {
              ':received': 'RECEIVED',
              ':assigned': 'ASSIGNED',
              ':version': expectedVersion,
              ':one': 1,
              ':category': update.category,
              ':suggested': update.suggestedPriority,
              ':priority': update.priority,
              ':teamId': update.teamId,
              ':deadlineAt': update.deadlineAt,
              ':policy': update.slaPolicyVersion,
              ':now': update.now,
              ':gsi1pk': `TEAM#${update.teamId}`,
              ':gsi1sk': `DEADLINE#${update.deadlineAt}`,
            },
          },
        },
        { Put: { TableName, Item: event } },
      ],
    }),
  );
}
