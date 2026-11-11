import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import type { TicketQuotaClaim } from './rate-limit.js';
import { tableName } from './tables.js';
import {
  Priority,
  StoredTicketPhoto,
  TicketEventRecord,
  TicketRecord,
  TicketStatus,
} from '../tickets/types.js';

/**
 * DynamoDB access for tickets, using the multi-table design of SCFRMS-28
 * (docs/database/dynamodb-access-patterns.md). One ticket is spread over:
 *
 *   Tickets          PK `ticketId`                       the ticket snapshot
 *       TeamOpenIndex: PK `teamStatusKey`, SK `createdKey`   (sparse: ASSIGNED and IN_PROGRESS)
 *       TeamDoneIndex: PK `teamDoneKey`, SK `completedKey`   (sparse: DONE; added for the completed list)
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
  teamDoneKey?: string;
  completedKey?: string;
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

/** The domain record for a stored ticket item and its photos. */
function toTicketRecord(
  item: TicketItem,
  photos: StoredTicketPhoto[],
): TicketRecord {
  return {
    ...omit(item, [
      'ticketId',
      'createdMonth',
      'createdKey',
      'teamStatusKey',
      'teamDoneKey',
      'completedKey',
    ]),
    id: item.ticketId,
    photos,
  } as TicketRecord;
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
    kind: 'CREATED',
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

  return toTicketRecord(ticket.Item as TicketItem, photos);
}

/** The reporter has used up the tickets they may create in this hour. */
export class QuotaExceededError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('The ticket creation limit is used up.');
    this.name = 'QuotaExceededError';
  }
}

/**
 * Creates a new ticket together with its reporter association, its photo
 * metadata and its CREATED audit event, all-or-nothing. The ticket Put
 * comes first and is conditional, so a ticket with this id already existing
 * cancels the transaction with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0) — the caller uses this to detect an
 * Idempotency-Key collision and avoid writing a duplicate.
 *
 * With a `quota` claim (SR-31, see shared/rate-limit.ts) the reporter's
 * counter is updated in the same transaction, last. Nothing is counted unless
 * the ticket is written, and a refused claim throws QuotaExceededError. If the
 * ticket already exists the original conditional failure is thrown instead, so
 * a retry of a request that went through still gets its answer.
 */
export async function createTicket(
  record: TicketRecord,
  quota?: TicketQuotaClaim,
): Promise<void> {
  const items = [
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
    ...(quota ? [{ Update: quota.update }] : []),
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    const reasons =
      (err as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons ?? [];
    if (
      quota &&
      (err as { name?: string }).name === 'TransactionCanceledException' &&
      reasons[items.length - 1]?.Code === 'ConditionalCheckFailed' &&
      reasons[0]?.Code !== 'ConditionalCheckFailed'
    ) {
      throw new QuotaExceededError(quota.retryAfterSeconds);
    }
    throw err;
  }
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
  /** The team of a technician account, recorded on the event (SR-11); a manager has none. */
  teamId?: string;
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
 *  - DONE also stores the repair proof photo (TicketPhotos) and `completedAt`,
 *    and puts the ticket in the team's completed list (`teamDoneKey`,
 *    `completedKey`; reopenTicket() removes both).
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
  if (!ticket.teamId) {
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
    ...(change.teamId ? { actorTeamId: change.teamId } : {}),
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
      '#version = #version + :one, teamDoneKey = :teamDoneKey, ' +
      'completedKey = :completedKey REMOVE teamStatusKey';
    values[':teamDoneKey'] = `TEAM#${ticket.teamId}`;
    values[':completedKey'] = timeKey(change.now, ticket.id);
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

/** DynamoDB allows at most 100 items in one transaction. */
export const MAX_TRANSACTION_ITEMS = 100;

export interface MergeChange {
  /** The technician account that merges; recorded as the actor of the events. */
  accountId: string;
  /** Its team (SR-11). */
  teamId: string;
  now: string;
  /** Reporters of the sources that the canonical ticket does not have yet. */
  reporters: { lineUserId: string; sourceTicketId: string }[];
  /** The canonical ticket's new priority and deadline, only when the merge changes them (SLA-09). */
  priority?: Priority;
  deadlineAt?: string;
  /** The earlier SLA start the canonical ticket takes from a merged ticket (SLA-09). */
  slaStartAt?: string;
}

/** How many items one merge writes: the tickets and their events, plus a reporter link each. */
export function mergeItemCount(
  sourceCount: number,
  reporterCount: number,
): number {
  return 2 + 2 * sourceCount + reporterCount;
}

/**
 * Merges duplicate tickets into a canonical ticket, all-or-nothing:
 *
 *  - every source becomes MERGED, points at the canonical ticket
 *    (`mergedIntoTicketId`) and leaves the team's open queue; its own report,
 *    photos, reporters and history stay as they were;
 *  - every reporter of the sources that the canonical ticket lacks is linked to
 *    it (`sourceTicketId` records where from), so they all can see it and are
 *    told about it;
 *  - the canonical ticket may get a higher priority and a new deadline;
 *  - a MERGED event is written on each source and a DUPLICATES_MERGED event on
 *    the canonical ticket.
 *
 * The canonical ticket and each source are updated only if they still are in
 * the status and at the version that were read; otherwise this fails with
 * TransactionCanceledException (reason ConditionalCheckFailed), and nothing
 * changes.
 */
export async function mergeTickets(
  canonical: TicketRecord,
  sources: TicketRecord[],
  change: MergeChange,
): Promise<void> {
  if (sources.length === 0) throw new Error('A merge needs a source ticket.');
  if (
    mergeItemCount(sources.length, change.reporters.length) >
    MAX_TRANSACTION_ITEMS
  ) {
    throw new Error('A merge this large does not fit in one transaction.');
  }

  const actor = {
    actorType: 'STAFF' as const,
    actorStaffId: change.accountId,
    actorTeamId: change.teamId,
  };
  const canonicalEvent: TicketEventRecord = {
    id: `${canonical.id}_duplicates_merged_v${canonical.version + 1}`,
    ticketId: canonical.id,
    kind: 'DUPLICATES_MERGED',
    occurredAt: change.now,
    ...actor,
    ...(change.priority ? { toPriority: change.priority } : {}),
    repairCycle: canonical.repairCycle,
    note:
      `Merged in ${sources.map((s) => `#${s.id}`).join(', ')}` +
      (change.priority ? `; priority raised to ${change.priority}` : ''),
  };

  const canonicalValues: Record<string, unknown> = {
    ':status': canonical.status,
    ':version': canonical.version,
    ':one': 1,
    ':now': change.now,
  };
  let canonicalUpdate = 'SET updatedAt = :now, #version = #version + :one';
  if (change.priority) {
    canonicalUpdate += ', priority = :priority';
    canonicalValues[':priority'] = change.priority;
  }
  if (change.deadlineAt) {
    canonicalUpdate += ', deadlineAt = :deadlineAt';
    canonicalValues[':deadlineAt'] = change.deadlineAt;
  }
  if (change.slaStartAt) {
    canonicalUpdate += ', slaStartAt = :slaStartAt';
    canonicalValues[':slaStartAt'] = change.slaStartAt;
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId: canonical.id },
            ConditionExpression: '#status = :status AND #version = :version',
            UpdateExpression: canonicalUpdate,
            ExpressionAttributeNames: {
              '#status': 'status',
              '#version': 'version',
            },
            ExpressionAttributeValues: canonicalValues,
          },
        },
        {
          Put: {
            TableName: tableName('TICKET_EVENTS'),
            Item: toEventItem(canonicalEvent),
          },
        },
        ...sources.flatMap((source) => {
          const event: TicketEventRecord = {
            id: `${source.id}_merged`,
            ticketId: source.id,
            kind: 'MERGED',
            occurredAt: change.now,
            ...actor,
            fromStatus: source.status,
            toStatus: 'MERGED',
            repairCycle: source.repairCycle,
            note: `Merged into #${canonical.id}`,
          };
          return [
            {
              Update: {
                TableName: tableName('TICKETS'),
                Key: { ticketId: source.id },
                ConditionExpression: '#status = :from AND #version = :version',
                UpdateExpression:
                  'SET #status = :merged, mergedIntoTicketId = :canonical, ' +
                  'updatedAt = :now, #version = #version + :one ' +
                  'REMOVE teamStatusKey',
                ExpressionAttributeNames: {
                  '#status': 'status',
                  '#version': 'version',
                },
                ExpressionAttributeValues: {
                  ':from': source.status,
                  ':version': source.version,
                  ':merged': 'MERGED',
                  ':canonical': canonical.id,
                  ':now': change.now,
                  ':one': 1,
                },
              },
            },
            {
              Put: {
                TableName: tableName('TICKET_EVENTS'),
                Item: toEventItem(event),
              },
            },
          ];
        }),
        ...change.reporters.map((reporter) => ({
          Put: {
            TableName: tableName('TICKET_REPORTERS'),
            Item: {
              ticketId: canonical.id,
              reporterLineUserId: reporter.lineUserId,
              associatedAt: change.now,
              associatedKey: timeKey(change.now, canonical.id),
              sourceTicketId: reporter.sourceTicketId,
            },
            ConditionExpression: 'attribute_not_exists(reporterLineUserId)',
          },
        })),
      ],
    }),
  );
}

/** Index page reads for one list request, so filtering cannot run without end. */
const MAX_INDEX_READS = 5;

export interface TicketFilter {
  /** Keep only these statuses. */
  statuses?: TicketStatus[];
  /** Keep only tickets with exactly this location text. */
  location?: string;
}

function matches(ticket: TicketRecord, filter: TicketFilter): boolean {
  if (filter.statuses && !filter.statuses.includes(ticket.status)) return false;
  if (filter.location !== undefined && ticket.location !== filter.location) {
    return false;
  }
  return true;
}

/** BatchGetItem takes at most 100 keys. */
const BATCH_GET_KEYS = 100;
const BATCH_GET_RETRIES = 3;

/**
 * The tickets with their photos, by id, read from the base table (strongly
 * consistent, so a list never shows a stale snapshot taken from an index).
 * An id with no ticket is left out.
 */
async function loadTickets(ids: string[]): Promise<Map<string, TicketRecord>> {
  const items: TicketItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH_GET_KEYS) {
    let keys: Record<string, unknown>[] = ids
      .slice(i, i + BATCH_GET_KEYS)
      .map((ticketId) => ({ ticketId }));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt > BATCH_GET_RETRIES) {
        throw new Error('Tickets could not be read: DynamoDB is throttling.');
      }
      const result = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName('TICKETS')]: { Keys: keys, ConsistentRead: true },
          },
        }),
      );
      items.push(
        ...((result.Responses?.[tableName('TICKETS')] ?? []) as TicketItem[]),
      );
      keys = result.UnprocessedKeys?.[tableName('TICKETS')]?.Keys ?? [];
    }
  }

  const records = await Promise.all(
    items.map(async (item) =>
      toTicketRecord(item, await getPhotos(item.ticketId)),
    ),
  );
  return new Map(records.map((record) => [record.id, record]));
}

export interface TicketListPage<Position> {
  tickets: TicketRecord[];
  /** Where the next page starts; absent when there is nothing more to read. */
  next?: Position;
}

/**
 * The tickets a reporter is associated with, newest association first,
 * merged sources included (ReporterTicketsIndex, eventually consistent).
 * `after` is the `next` of the previous page.
 */
export async function listReporterTickets(
  reporterLineUserId: string,
  options: { limit: number; after?: string; filter: TicketFilter },
): Promise<TicketListPage<string>> {
  const tickets: TicketRecord[] = [];
  let after = options.after;

  for (let read = 0; read < MAX_INDEX_READS; read++) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName('TICKET_REPORTERS'),
        IndexName: 'ReporterTicketsIndex',
        KeyConditionExpression: after
          ? 'reporterLineUserId = :reporter AND associatedKey < :after'
          : 'reporterLineUserId = :reporter',
        ExpressionAttributeValues: {
          ':reporter': reporterLineUserId,
          ...(after ? { ':after': after } : {}),
        },
        ScanIndexForward: false,
        Limit: options.limit,
      }),
    );
    const entries = (page.Items ?? []) as ReporterItem[];
    const loaded = await loadTickets(entries.map((e) => e.ticketId));

    for (const entry of entries) {
      after = entry.associatedKey;
      const ticket = loaded.get(entry.ticketId);
      if (ticket && matches(ticket, options.filter)) {
        tickets.push(ticket);
        if (tickets.length === options.limit) return { tickets, next: after };
      }
    }
    if (!page.LastEvaluatedKey) return { tickets };
  }
  return { tickets, next: after };
}

export type OpenStatus = 'ASSIGNED' | 'IN_PROGRESS';

/** Per open status, the `createdKey` of the last ticket already returned. */
export type OpenPosition = Partial<Record<OpenStatus, string>>;

interface OpenQueue {
  status: OpenStatus;
  position?: string;
  buffer: { ticketId: string; createdKey: string }[];
  exhausted: boolean;
}

/**
 * A team's open tickets in the given statuses (TeamOpenIndex), oldest first
 * across the statuses. `after` is the `next` of the previous page.
 */
export async function listTeamTickets(
  teamId: string,
  statuses: OpenStatus[],
  options: { limit: number; after: OpenPosition; filter: TicketFilter },
): Promise<TicketListPage<OpenPosition>> {
  const queues: OpenQueue[] = statuses.map((status) => ({
    status,
    position: options.after[status],
    buffer: [],
    exhausted: false,
  }));
  let reads = 0;

  async function fill(queue: OpenQueue): Promise<void> {
    reads++;
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName('TICKETS'),
        IndexName: 'TeamOpenIndex',
        KeyConditionExpression: queue.position
          ? 'teamStatusKey = :key AND createdKey > :after'
          : 'teamStatusKey = :key',
        ExpressionAttributeValues: {
          ':key': `TEAM#${teamId}#STATUS#${queue.status}`,
          ...(queue.position ? { ':after': queue.position } : {}),
        },
        Limit: options.limit,
      }),
    );
    queue.buffer = (page.Items ?? []) as OpenQueue['buffer'];
    queue.exhausted = !page.LastEvaluatedKey;
  }

  /** The next `count` entries in createdKey order across the queues. */
  async function take(count: number): Promise<[OpenQueue, string][]> {
    const taken: [OpenQueue, string][] = [];
    while (taken.length < count && reads < MAX_INDEX_READS * queues.length) {
      for (const queue of queues) {
        if (queue.buffer.length === 0 && !queue.exhausted) await fill(queue);
      }
      const heads = queues.filter((q) => q.buffer.length > 0);
      if (heads.length === 0) break;
      const first = heads.reduce((a, b) =>
        a.buffer[0].createdKey <= b.buffer[0].createdKey ? a : b,
      );
      const entry = first.buffer.shift() as OpenQueue['buffer'][number];
      first.position = entry.createdKey;
      taken.push([first, entry.ticketId]);
    }
    return taken;
  }

  const tickets: TicketRecord[] = [];
  while (tickets.length < options.limit) {
    const taken = await take(options.limit - tickets.length);
    if (taken.length === 0) break;
    const loaded = await loadTickets(taken.map(([, id]) => id));
    for (const [, id] of taken) {
      const ticket = loaded.get(id);
      if (ticket && matches(ticket, options.filter)) tickets.push(ticket);
    }
  }

  const more = queues.some((q) => q.buffer.length > 0 || !q.exhausted);
  if (!more) return { tickets };
  const next: OpenPosition = {};
  for (const queue of queues) {
    if (queue.position) next[queue.status] = queue.position;
  }
  return { tickets, next };
}

/**
 * A team's completed tickets, newest completion first (TeamDoneIndex).
 * `from` and `toExclusive` bound `completedAt` as ISO date or timestamp
 * prefixes; `after` is the `next` of the previous page.
 */
export async function listCompletedTickets(
  teamId: string,
  options: {
    limit: number;
    after?: string;
    from?: string;
    toExclusive?: string;
    filter: TicketFilter;
  },
): Promise<TicketListPage<string>> {
  const tickets: TicketRecord[] = [];
  // Entries at or above this key were returned already or are out of range.
  const upper = [options.after, options.toExclusive]
    .filter((v): v is string => v !== undefined)
    .sort()[0];
  let upperKey = upper;

  for (let read = 0; read < MAX_INDEX_READS; read++) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName('TICKETS'),
        IndexName: 'TeamDoneIndex',
        KeyConditionExpression:
          'teamDoneKey = :key AND completedKey BETWEEN :low AND :high',
        ExpressionAttributeValues: {
          ':key': `TEAM#${teamId}`,
          ':low': options.from ?? '0',
          ':high': upperKey ?? '9',
        },
        ScanIndexForward: false,
        Limit: options.limit + 1,
      }),
    );
    const entries = ((page.Items ?? []) as TicketItem[]).filter(
      (item) =>
        upperKey === undefined || (item.completedKey as string) < upperKey,
    );
    const loaded = await loadTickets(entries.map((e) => e.ticketId));

    for (const entry of entries) {
      upperKey = entry.completedKey as string;
      const ticket = loaded.get(entry.ticketId);
      if (ticket && matches(ticket, options.filter)) {
        tickets.push(ticket);
        if (tickets.length === options.limit) {
          return { tickets, next: upperKey };
        }
      }
    }
    if (!page.LastEvaluatedKey) return { tickets };
  }
  return { tickets, next: upperKey };
}

function fromEventItem(item: EventItem): TicketEventRecord {
  return omit(item, ['eventKey']) as unknown as TicketEventRecord;
}

export interface TicketEventPage {
  events: TicketEventRecord[];
  /** The `eventKey` to continue after; absent on the last page. */
  next?: string;
}

/**
 * A ticket's audit events in time order (TicketEvents, strongly consistent).
 * `after` is the `next` of the previous page. One more event than `limit` is
 * read to know whether there is a next page, so the last page has no `next`.
 */
export async function listTicketEvents(
  ticketId: string,
  options: { limit: number; after?: string },
): Promise<TicketEventPage> {
  const page = await ddb.send(
    new QueryCommand({
      TableName: tableName('TICKET_EVENTS'),
      KeyConditionExpression: options.after
        ? 'ticketId = :ticketId AND eventKey > :after'
        : 'ticketId = :ticketId',
      ExpressionAttributeValues: {
        ':ticketId': ticketId,
        ...(options.after ? { ':after': options.after } : {}),
      },
      ConsistentRead: true,
      ScanIndexForward: true,
      Limit: options.limit + 1,
    }),
  );
  const items = (page.Items ?? []) as EventItem[];
  const shown = items.slice(0, options.limit);
  return {
    events: shown.map(fromEventItem),
    ...(items.length > options.limit
      ? { next: shown[shown.length - 1].eventKey }
      : {}),
  };
}

export interface PriorityChange {
  to: Priority;
  /** The staff account that decides; recorded as the actor of the event. */
  accountId: string;
  /** The team of a technician account (SR-11); a manager has none. */
  teamId?: string;
  now: string;
  /** Why it changed; required by the endpoint when the priority changes. */
  reason?: string;
  /** The new deadline, only when it differs from the current one (SLA-07). */
  deadlineAt?: string;
}

/**
 * A person decides the priority of an open ticket, in one transaction with
 * the audit event: a different value is PRIORITY_CHANGED, the same value
 * (accepting what the AI chose) is PRIORITY_CONFIRMED. Either way
 * `prioritySetBy` becomes STAFF, so the AI never overwrites it.
 *
 * Only succeeds if the ticket is still ASSIGNED or IN_PROGRESS at the version
 * that was read. Otherwise it fails with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0).
 */
export async function setTicketPriority(
  ticket: TicketRecord,
  change: PriorityChange,
): Promise<void> {
  const event: TicketEventRecord = {
    id: `${ticket.id}_priority_v${ticket.version + 1}`,
    ticketId: ticket.id,
    kind:
      ticket.priority === change.to ? 'PRIORITY_CONFIRMED' : 'PRIORITY_CHANGED',
    occurredAt: change.now,
    actorType: 'STAFF',
    actorStaffId: change.accountId,
    ...(change.teamId ? { actorTeamId: change.teamId } : {}),
    ...(ticket.priority ? { fromPriority: ticket.priority } : {}),
    toPriority: change.to,
    repairCycle: ticket.repairCycle,
    ...(change.reason ? { note: change.reason } : {}),
  };

  const values: Record<string, unknown> = {
    ':assigned': 'ASSIGNED',
    ':inProgress': 'IN_PROGRESS',
    ':version': ticket.version,
    ':one': 1,
    ':now': change.now,
    ':priority': change.to,
    ':staff': 'STAFF',
  };
  let update =
    'SET priority = :priority, prioritySetBy = :staff, updatedAt = :now, ' +
    '#version = #version + :one';
  if (change.deadlineAt) {
    update += ', deadlineAt = :deadlineAt';
    values[':deadlineAt'] = change.deadlineAt;
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId: ticket.id },
            ConditionExpression:
              '#status IN (:assigned, :inProgress) AND #version = :version',
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
      ],
    }),
  );
}

export interface ReopenChange {
  now: string;
  /** A hash of the Idempotency-Key, kept on the ticket to recognise a retry. */
  reopenKey: string;
  /** Why the reporter reopens it, when they said. */
  reason?: string;
  /** The new deadline: a new resolution clock from `now`, same priority (SLA-10). */
  deadlineAt?: string;
}

/**
 * A reporter reopens a ticket that is DONE (RR-03): it goes back to ASSIGNED,
 * to the team's open queue and out of the completed list, in one transaction
 * with a REOPENED audit event.
 *
 *  - `repairCycle` goes up by one; the event records the new cycle, and the
 *    earlier cycle's events and proof photos stay as they were.
 *  - `completedAt` is removed, the ticket is no longer completed.
 *  - A new SLA clock starts now (SLA-10): `slaStartAt` is `now` and
 *    `deadlineAt` is counted from it with the same priority.
 *
 * Only succeeds if the ticket is still DONE at the version that was read.
 * Otherwise it fails with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0).
 */
export async function reopenTicket(
  ticket: TicketRecord,
  change: ReopenChange,
): Promise<void> {
  if (!ticket.teamId) throw new Error(`Ticket ${ticket.id} has no team.`);

  const event: TicketEventRecord = {
    id: `${ticket.id}_reopened_v${ticket.version + 1}`,
    ticketId: ticket.id,
    kind: 'REOPENED',
    occurredAt: change.now,
    actorType: 'REPORTER',
    fromStatus: 'DONE',
    toStatus: 'ASSIGNED',
    repairCycle: ticket.repairCycle + 1,
    ...(change.reason ? { note: change.reason } : {}),
  };

  const values: Record<string, unknown> = {
    ':done': 'DONE',
    ':assigned': 'ASSIGNED',
    ':version': ticket.version,
    ':one': 1,
    ':now': change.now,
    ':cycle': ticket.repairCycle + 1,
    ':teamStatusKey': `TEAM#${ticket.teamId}#STATUS#ASSIGNED`,
    ':reopenKey': change.reopenKey,
  };
  let update =
    'SET #status = :assigned, repairCycle = :cycle, updatedAt = :now, ' +
    '#version = #version + :one, teamStatusKey = :teamStatusKey, ' +
    'slaStartAt = :now, reopenKey = :reopenKey';
  if (change.deadlineAt) {
    update += ', deadlineAt = :deadlineAt';
    values[':deadlineAt'] = change.deadlineAt;
  }
  update += ' REMOVE completedAt, teamDoneKey, completedKey';

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId: ticket.id },
            ConditionExpression: '#status = :done AND #version = :version',
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
      ],
    }),
  );
}

export interface ReassignChange {
  /** The team that takes the ticket. */
  toTeamId: string;
  /** The manager that decides; recorded as the actor of the event. */
  accountId: string;
  now: string;
  /** Why the team changes. */
  reason: string;
  /** The deadline counted with the new team's policy, only when it differs (SLA-08). */
  deadlineAt?: string;
}

/**
 * A manager moves an ASSIGNED ticket to another team, in one transaction with
 * the audit event: the ticket leaves the old team's open queue and enters the
 * new team's (`teamStatusKey`), and a REASSIGNED event records the old team,
 * the new team, the actor and the reason. Work that has started is not moved.
 *
 * Only succeeds if the ticket is still ASSIGNED at the version that was read.
 * Otherwise it fails with TransactionCanceledException (reason
 * ConditionalCheckFailed at index 0).
 */
export async function reassignTicket(
  ticket: TicketRecord,
  change: ReassignChange,
): Promise<void> {
  if (!ticket.teamId) throw new Error(`Ticket ${ticket.id} has no team.`);

  const event: TicketEventRecord = {
    id: `${ticket.id}_reassigned_v${ticket.version + 1}`,
    ticketId: ticket.id,
    kind: 'REASSIGNED',
    occurredAt: change.now,
    actorType: 'STAFF',
    actorStaffId: change.accountId,
    fromTeamId: ticket.teamId,
    toTeamId: change.toTeamId,
    repairCycle: ticket.repairCycle,
    note: change.reason,
  };

  const values: Record<string, unknown> = {
    ':assigned': 'ASSIGNED',
    ':version': ticket.version,
    ':one': 1,
    ':now': change.now,
    ':team': change.toTeamId,
    ':teamStatusKey': `TEAM#${change.toTeamId}#STATUS#ASSIGNED`,
  };
  let update =
    'SET teamId = :team, teamStatusKey = :teamStatusKey, updatedAt = :now, ' +
    '#version = #version + :one';
  if (change.deadlineAt) {
    update += ', deadlineAt = :deadlineAt';
    values[':deadlineAt'] = change.deadlineAt;
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName('TICKETS'),
            Key: { ticketId: ticket.id },
            ConditionExpression: '#status = :assigned AND #version = :version',
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
      ],
    }),
  );
}
