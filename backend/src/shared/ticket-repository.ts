import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';
import {
  Priority,
  StoredTicketPhoto,
  TicketEventRecord,
  TicketRecord,
} from '../tickets/types.js';

/**
 * DynamoDB access for tickets, using the multi-table design of SCFRMS-28
 * (docs/database/dynamodb-access-patterns.md). One ticket is spread over:
 *
 *   Tickets          PK `ticketId`                       the ticket snapshot
 *       TeamOpenIndex: PK `teamStatusKey`, SK `createdKey`   (sparse: ASSIGNED only for now)
 *       CreatedMonthIndex: PK `createdMonth`, SK `createdKey`
 *   TicketReporters  PK `ticketId`, SK `reporterLineUserId`
 *       ReporterTicketsIndex: PK `reporterLineUserId`, SK `associatedKey`
 *   TicketPhotos     PK `ticketId`, SK `photoId`
 *   TicketEvents     PK `ticketId`, SK `eventKey` = `<occurredAt>#<eventId>`
 *
 * The domain type TicketRecord keeps `id` and an embedded `photos` list; this
 * module maps it to and from the stored items, so callers never see the
 * storage attributes. Writes that belong together are one transaction, which
 * DynamoDB allows across tables. Table names come from shared/tables.ts.
 */

type TicketItem = Omit<TicketRecord, 'id' | 'photos'> & {
  ticketId: string;
  createdMonth: string;
  createdKey: string;
  teamStatusKey?: string;
};

type ReporterItem = {
  ticketId: string;
  reporterLineUserId: string;
  associatedAt: string;
  associatedKey: string;
};

type PhotoItem = Omit<StoredTicketPhoto, 'id'> & {
  ticketId: string;
  photoId: string;
};

type EventItem = TicketEventRecord & { eventKey: string };

/** A copy of `source` without the listed attributes. */
function omit<T extends object>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

/** `<timestamp>#<ticketId>`: orders by time and breaks ties by id. */
function timeKey(timestamp: string, ticketId: string): string {
  return `${timestamp}#${ticketId}`;
}

function toTicketItem(record: TicketRecord): TicketItem {
  return {
    ...omit(record, ['id', 'photos']),
    ticketId: record.id,
    createdMonth: record.createdAt.slice(0, 7),
    createdKey: timeKey(record.createdAt, record.id),
  } as TicketItem;
}

function toReporterItem(record: TicketRecord): ReporterItem {
  return {
    ticketId: record.id,
    reporterLineUserId: record.reporterLineUserId,
    associatedAt: record.createdAt,
    associatedKey: timeKey(record.createdAt, record.id),
  };
}

function toPhotoItem(ticketId: string, photo: StoredTicketPhoto): PhotoItem {
  return { ...omit(photo, ['id']), ticketId, photoId: photo.id } as PhotoItem;
}

function fromPhotoItem(item: PhotoItem): StoredTicketPhoto {
  return {
    ...omit(item, ['ticketId', 'photoId']),
    id: item.photoId,
  } as StoredTicketPhoto;
}

function toEventItem(event: TicketEventRecord): EventItem {
  return { ...event, eventKey: `${event.occurredAt}#${event.id}` };
}

function toCreatedEvent(record: TicketRecord): TicketEventRecord {
  return {
    id: `${record.id}_created`,
    ticketId: record.id,
    kind: 'TICKET_CREATED',
    occurredAt: record.createdAt,
    actorType: 'REPORTER',
    toStatus: record.status,
    repairCycle: record.repairCycle,
  };
}

async function getPhotos(ticketId: string): Promise<StoredTicketPhoto[]> {
  const photos: StoredTicketPhoto[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName('TICKET_PHOTOS'),
        KeyConditionExpression: 'ticketId = :ticketId',
        ExpressionAttributeValues: { ':ticketId': ticketId },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      photos.push(fromPhotoItem(item as PhotoItem));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return photos;
}

/**
 * Reads the ticket and its photos. Both reads are strongly consistent, so a
 * ticket written by createTicket is never seen without its photo.
 */
export async function getTicket(
  ticketId: string,
): Promise<TicketRecord | null> {
  const [ticket, photos] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName('TICKETS'),
        Key: { ticketId },
        ConsistentRead: true,
      }),
    ),
    getPhotos(ticketId),
  ]);
  if (!ticket.Item) return null;

  const item = ticket.Item as TicketItem;
  return {
    ...omit(item, ['ticketId', 'createdMonth', 'createdKey', 'teamStatusKey']),
    id: item.ticketId,
    photos,
  } as TicketRecord;
}

/**
 * Creates a new ticket together with its reporter association, its photo
 * metadata and its TICKET_CREATED audit event, all-or-nothing. The ticket Put
 * comes first and is conditional, so a ticket with this id already existing
 * cancels the transaction with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0) — the caller uses this to detect an
 * Idempotency-Key collision and avoid writing a duplicate.
 */
export async function createTicket(record: TicketRecord): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName('TICKETS'),
            Item: toTicketItem(record),
            ConditionExpression: 'attribute_not_exists(ticketId)',
          },
        },
        {
          Put: {
            TableName: tableName('TICKET_REPORTERS'),
            Item: toReporterItem(record),
          },
        },
        ...record.photos.map((photo) => ({
          Put: {
            TableName: tableName('TICKET_PHOTOS'),
            Item: toPhotoItem(record.id, photo),
          },
        })),
        {
          Put: {
            TableName: tableName('TICKET_EVENTS'),
            Item: toEventItem(toCreatedEvent(record)),
          },
        },
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
  /** Set when the safety override (SLA-02) decided the priority. */
  safetyHazard?: string;
  /** Time of this update; also the audit event's occurredAt. */
  now: string;
}

/**
 * Applies a validated triage result: RECEIVED -> ASSIGNED, sets category,
 * priority, team and deadline, bumps `version`, and sets `teamStatusKey` so
 * the ticket appears in the team's open queue (TeamOpenIndex) — all in one
 * transaction with a TRIAGED audit event.
 *
 * Only succeeds if the ticket is still RECEIVED at `expectedVersion`.
 * Otherwise it fails with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0), so a duplicate triage run changes
 * nothing.
 */
export async function applyTriage(
  ticketId: string,
  expectedVersion: number,
  update: TriageUpdate,
): Promise<void> {
  const event: TicketEventRecord = {
    id: `${ticketId}_triaged`,
    ticketId,
    kind: 'TRIAGED',
    occurredAt: update.now,
    actorType: 'SYSTEM',
    fromStatus: 'RECEIVED',
    toStatus: 'ASSIGNED',
    toPriority: update.priority,
    toTeamId: update.teamId,
    ...(update.safetyHazard
      ? { note: `SAFETY_OVERRIDE:${update.safetyHazard}` }
      : {}),
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId },
            ConditionExpression: '#status = :received AND #version = :version',
            UpdateExpression:
              'SET #status = :assigned, category = :category, ' +
              'suggestedPriority = :suggested, priority = :priority, ' +
              'teamId = :teamId, deadlineAt = :deadlineAt, ' +
              'slaPolicyVersion = :policy, triagedAt = :now, ' +
              'updatedAt = :now, #version = #version + :one, ' +
              'teamStatusKey = :teamStatusKey, prioritySetBy = :prioritySetBy' +
              (update.safetyHazard ? ', safetyHazard = :hazard' : ''),
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
              ':teamStatusKey': `TEAM#${update.teamId}#STATUS#ASSIGNED`,
              ':prioritySetBy': 'AI',
              ...(update.safetyHazard
                ? { ':hazard': update.safetyHazard }
                : {}),
            },
          },
        },
        {
          Put: {
            TableName: tableName('TICKET_EVENTS'),
            Item: toEventItem(event),
          },
        },
      ],
    }),
  );
}

export interface StatusChange {
  to: 'IN_PROGRESS' | 'DONE';
  /** The staff account that makes the change; recorded as the actor of the event. */
  accountId: string;
  now: string;
  /** The verified REPAIR_PROOF upload; required for DONE. */
  proof?: { photoId: string; s3ObjectKey: string };
}

/**
 * Moves a ticket ASSIGNED -> IN_PROGRESS or IN_PROGRESS -> DONE, in one
 * transaction with a STATUS_CHANGED audit event.
 *
 *  - IN_PROGRESS puts the ticket in the team's IN_PROGRESS queue
 *    (`teamStatusKey`); DONE removes it from the open queue.
 *  - DONE also stores the repair proof photo (TicketPhotos) and `completedAt`.
 *
 * Only succeeds if the ticket is in the expected status at the version that
 * was read. Otherwise it fails with
 * TransactionCanceledException (reason ConditionalCheckFailed at index 0).
 */
export async function changeTicketStatus(
  ticket: TicketRecord,
  change: StatusChange,
): Promise<void> {
  const done = change.to === 'DONE';
  if (done && !change.proof) {
    throw new Error('A DONE status needs a proof photo.');
  }
  if (!done && !ticket.teamId) {
    throw new Error(`Ticket ${ticket.id} has no team.`);
  }

  const from = done ? 'IN_PROGRESS' : 'ASSIGNED';
  const event: TicketEventRecord = {
    id: `${ticket.id}_status_v${ticket.version + 1}`,
    ticketId: ticket.id,
    kind: 'STATUS_CHANGED',
    occurredAt: change.now,
    actorType: 'STAFF',
    actorStaffId: change.accountId,
    fromStatus: from,
    toStatus: change.to,
    repairCycle: ticket.repairCycle,
    ...(change.proof ? { proofPhotoId: change.proof.photoId } : {}),
  };

  const values: Record<string, unknown> = {
    ':from': from,
    ':to': change.to,
    ':version': ticket.version,
    ':one': 1,
    ':now': change.now,
  };
  let update: string;
  if (done) {
    update =
      'SET #status = :to, completedAt = :now, updatedAt = :now, ' +
      '#version = #version + :one REMOVE teamStatusKey';
  } else {
    update =
      'SET #status = :to, updatedAt = :now, #version = #version + :one, ' +
      'teamStatusKey = :teamStatusKey';
    values[':teamStatusKey'] = `TEAM#${ticket.teamId}#STATUS#IN_PROGRESS`;
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId: ticket.id },
            ConditionExpression: '#status = :from AND #version = :version',
            UpdateExpression: update,
            ExpressionAttributeNames: {
              '#status': 'status',
              '#version': 'version',
            },
            ExpressionAttributeValues: values,
          },
        },
        {
          Put: {
            TableName: tableName('TICKET_EVENTS'),
            Item: toEventItem(event),
          },
        },
        ...(change.proof
          ? [
              {
                Put: {
                  TableName: tableName('TICKET_PHOTOS'),
                  Item: toPhotoItem(ticket.id, {
                    id: change.proof.photoId,
                    purpose: 'REPAIR_PROOF',
                    addedAt: change.now,
                    repairCycle: ticket.repairCycle,
                    s3ObjectKey: change.proof.s3ObjectKey,
                  }),
                  ConditionExpression: 'attribute_not_exists(photoId)',
                },
              },
            ]
          : []),
      ],
    }),
  );
}
