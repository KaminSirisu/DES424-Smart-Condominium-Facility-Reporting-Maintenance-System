import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  listCompletedTickets,
  listReporterTickets,
  listTeamTickets,
} from '../../backend/src/shared/ticket-repository.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, string | number | undefined>;

/** An in-memory stand-in for the tables and indexes the list queries read. */
const db: { tickets: Row[]; reporters: Row[]; photos: Row[] } = {
  tickets: [],
  reporters: [],
  photos: [],
};

interface Command {
  constructor: { name: string };
  input: {
    TableName: string;
    IndexName?: string;
    Limit?: number;
    ScanIndexForward?: boolean;
    ExpressionAttributeValues?: Record<string, string>;
    RequestItems?: Record<string, { Keys: { ticketId: string }[] }>;
  };
}

const commands = (name: string) =>
  send.mock.calls
    .map((call) => call[0] as Command)
    .filter((c) => c.constructor.name === name);

/** Rows in key order (`key`), limited like Query: LastEvaluatedKey when more remain. */
function page(rows: Row[], key: string, command: Command) {
  const sorted = [...rows].sort((a, b) =>
    String(a[key]).localeCompare(String(b[key])),
  );
  if (command.input.ScanIndexForward === false) sorted.reverse();
  const limit = command.input.Limit ?? sorted.length;
  return {
    Items: sorted.slice(0, limit),
    ...(sorted.length > limit
      ? { LastEvaluatedKey: { key: sorted[limit - 1][key] } }
      : {}),
  };
}

/** Applies the comparison that the key condition names, so the tests see a wrong operator. */
function compare(expression: string, attribute: string, a: string, b: string) {
  const op = new RegExp(`${attribute} (<=|>=|<|>)`).exec(expression)?.[1];
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      throw new Error(`No ${attribute} comparison in: ${expression}`);
  }
}

function fakeDynamo() {
  send.mockImplementation(async (command: Command) => {
    const { input } = command;
    const v = input.ExpressionAttributeValues ?? {};
    const expression = String(
      (input as { KeyConditionExpression?: string }).KeyConditionExpression,
    );

    if (command.constructor.name === 'BatchGetCommand') {
      const [table, request] = Object.entries(input.RequestItems ?? {})[0];
      const ids = request.Keys.map((k) => k.ticketId);
      return {
        Responses: {
          [table]: db.tickets.filter((t) => ids.includes(String(t.ticketId))),
        },
      };
    }

    if (input.IndexName === 'ReporterTicketsIndex') {
      return page(
        db.reporters.filter(
          (r) =>
            r.reporterLineUserId === v[':reporter'] &&
            (!v[':after'] ||
              compare(
                expression,
                'associatedKey',
                String(r.associatedKey),
                v[':after'],
              )),
        ),
        'associatedKey',
        command,
      );
    }
    if (input.IndexName === 'TeamOpenIndex') {
      return page(
        db.tickets.filter(
          (t) =>
            t.teamStatusKey === v[':key'] &&
            (!v[':after'] ||
              compare(
                expression,
                'createdKey',
                String(t.createdKey),
                v[':after'],
              )),
        ),
        'createdKey',
        command,
      );
    }
    if (input.IndexName === 'TeamDoneIndex') {
      return page(
        db.tickets.filter(
          (t) =>
            t.teamDoneKey === v[':key'] &&
            String(t.completedKey) >= v[':low'] &&
            String(t.completedKey) <= v[':high'],
        ),
        'completedKey',
        command,
      );
    }
    // TicketPhotos by ticket id
    return {
      Items: db.photos.filter((p) => p.ticketId === v[':ticketId']),
    };
  });
}

/** Ticket `n`, created on 2026-11-0<n>. */
function addTicket(n: number, overrides: Row = {}): Row {
  const createdAt = `2026-11-0${n}T08:00:00.000Z`;
  const row: Row = {
    ticketId: `tkt_${n}`,
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    version: 2,
    reporterLineUserId: 'Uaaa',
    teamId: 'PLUMBING',
    createdMonth: '2026-11',
    createdKey: `${createdAt}#tkt_${n}`,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
  db.tickets.push(row);
  return row;
}

function associate(n: number, reporter = 'Uaaa', at?: string) {
  const associatedAt = at ?? `2026-11-0${n}T08:00:00.000Z`;
  db.reporters.push({
    ticketId: `tkt_${n}`,
    reporterLineUserId: reporter,
    associatedAt,
    associatedKey: `${associatedAt}#tkt_${n}`,
  });
}

const ids = (tickets: { id: string }[]) => tickets.map((t) => t.id);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_REPORTERS_TABLE_NAME', 'TestReporters');
  vi.stubEnv('TICKET_PHOTOS_TABLE_NAME', 'TestPhotos');
  db.tickets = [];
  db.reporters = [];
  db.photos = [];
  fakeDynamo();
});
afterEach(() => vi.unstubAllEnvs());

describe('listReporterTickets', () => {
  it('lists the reporter tickets newest first, with photos and without storage attributes', async () => {
    for (const n of [1, 2, 3]) {
      addTicket(n);
      associate(n);
    }
    db.photos.push({
      ticketId: 'tkt_3',
      photoId: 'upl_3',
      purpose: 'DEFECT',
      addedAt: '2026-11-03T08:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Uaaa/upl_3',
    });

    const result = await listReporterTickets('Uaaa', {
      limit: 10,
      filter: {},
    });

    expect(ids(result.tickets)).toEqual(['tkt_3', 'tkt_2', 'tkt_1']);
    expect(result.next).toBeUndefined();
    expect(result.tickets[0]).toMatchObject({
      id: 'tkt_3',
      photos: [{ id: 'upl_3', purpose: 'DEFECT' }],
    });
    expect(result.tickets[0]).not.toHaveProperty('ticketId');
    expect(result.tickets[0]).not.toHaveProperty('createdKey');
    expect(commands('QueryCommand')[0].input).toMatchObject({
      TableName: 'TestReporters',
      IndexName: 'ReporterTicketsIndex',
      ScanIndexForward: false,
    });
    expect(commands('BatchGetCommand')[0].input.RequestItems).toEqual({
      TestTickets: {
        Keys: expect.any(Array),
        ConsistentRead: true,
      },
    });
  });

  it('pages through every ticket once, newest first', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      addTicket(n);
      associate(n);
    }

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const result = await listReporterTickets('Uaaa', {
        limit: 2,
        after,
        filter: {},
      });
      seen.push(...ids(result.tickets));
      after = result.next;
      pages++;
    } while (after);

    expect(seen).toEqual(['tkt_5', 'tkt_4', 'tkt_3', 'tkt_2', 'tkt_1']);
    expect(pages).toBeLessThanOrEqual(4);
  });

  it('includes a merged source by its own association, and nobody elses tickets', async () => {
    addTicket(1, { status: 'MERGED', mergedIntoTicketId: 'tkt_2' });
    addTicket(2);
    addTicket(3, { reporterLineUserId: 'Ubbb' });
    associate(1);
    associate(2, 'Uaaa', '2026-11-05T09:00:00.000Z'); // copied at a merge
    associate(3, 'Ubbb');

    const result = await listReporterTickets('Uaaa', {
      limit: 10,
      filter: {},
    });

    expect(ids(result.tickets)).toEqual(['tkt_2', 'tkt_1']);
    expect(result.tickets[1]).toMatchObject({
      status: 'MERGED',
      mergedIntoTicketId: 'tkt_2',
    });
  });

  it('filters by status and location after reading, and keeps reading to fill a page', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      addTicket(n, {
        status: n % 2 ? 'DONE' : 'ASSIGNED',
        location: n === 1 ? 'Gym' : 'Lobby',
      });
      associate(n);
    }

    const done = await listReporterTickets('Uaaa', {
      limit: 2,
      filter: { statuses: ['DONE'] },
    });
    expect(ids(done.tickets)).toEqual(['tkt_5', 'tkt_3']);

    const gym = await listReporterTickets('Uaaa', {
      limit: 2,
      filter: { location: 'Gym' },
    });
    expect(ids(gym.tickets)).toEqual(['tkt_1']);
    expect(gym.next).toBeUndefined();
  });

  it('leaves out an index entry whose ticket is gone', async () => {
    addTicket(1);
    associate(1);
    associate(2); // no ticket 2

    const result = await listReporterTickets('Uaaa', {
      limit: 10,
      filter: {},
    });
    expect(ids(result.tickets)).toEqual(['tkt_1']);
  });

  it('stops after a few reads and hands back a cursor when nothing matches', async () => {
    for (let n = 1; n <= 9; n++) {
      addTicket(n, { location: 'Lobby' });
      associate(n);
    }

    const result = await listReporterTickets('Uaaa', {
      limit: 1,
      filter: { location: 'Nowhere' },
    });

    expect(result.tickets).toEqual([]);
    expect(result.next).toBeDefined();
    expect(
      commands('QueryCommand').filter((c) => c.input.IndexName),
    ).toHaveLength(5);
  });
});

describe('listTeamTickets', () => {
  const queueKey = (status: string) => `TEAM#PLUMBING#STATUS#${status}`;

  function addOpen(
    n: number,
    status: 'ASSIGNED' | 'IN_PROGRESS',
    extra: Row = {},
  ) {
    addTicket(n, { status, teamStatusKey: queueKey(status), ...extra });
  }

  it('merges the statuses oldest first and leaves other teams and closed tickets out', async () => {
    addOpen(1, 'IN_PROGRESS');
    addOpen(2, 'ASSIGNED');
    addOpen(3, 'IN_PROGRESS');
    addOpen(4, 'ASSIGNED');
    addTicket(5, { status: 'DONE' }); // left the queue
    addTicket(6, {
      status: 'ASSIGNED',
      teamId: 'ELECTRICAL',
      teamStatusKey: 'TEAM#ELECTRICAL#STATUS#ASSIGNED',
    });

    const result = await listTeamTickets(
      'PLUMBING',
      ['ASSIGNED', 'IN_PROGRESS'],
      { limit: 10, after: {}, filter: {} },
    );

    expect(ids(result.tickets)).toEqual(['tkt_1', 'tkt_2', 'tkt_3', 'tkt_4']);
    expect(result.next).toBeUndefined();
    const keys = commands('QueryCommand')
      .filter((c) => c.input.IndexName === 'TeamOpenIndex')
      .map((c) => c.input.ExpressionAttributeValues?.[':key']);
    expect(keys.sort()).toEqual([
      'TEAM#PLUMBING#STATUS#ASSIGNED',
      'TEAM#PLUMBING#STATUS#IN_PROGRESS',
    ]);
  });

  it('pages through both statuses once each, in order, with a cursor that holds a position per status', async () => {
    addOpen(1, 'IN_PROGRESS');
    addOpen(2, 'ASSIGNED');
    addOpen(3, 'IN_PROGRESS');
    addOpen(4, 'ASSIGNED');
    addOpen(5, 'ASSIGNED');

    const seen: string[] = [];
    let after = {};
    let pages = 0;
    do {
      const result = await listTeamTickets(
        'PLUMBING',
        ['ASSIGNED', 'IN_PROGRESS'],
        { limit: 2, after, filter: {} },
      );
      seen.push(...ids(result.tickets));
      after = result.next ?? {};
      pages++;
      if (!result.next) break;
    } while (pages < 10);

    expect(seen).toEqual(['tkt_1', 'tkt_2', 'tkt_3', 'tkt_4', 'tkt_5']);
  });

  it('lists a single status', async () => {
    addOpen(1, 'IN_PROGRESS');
    addOpen(2, 'ASSIGNED');

    const result = await listTeamTickets('PLUMBING', ['ASSIGNED'], {
      limit: 10,
      after: {},
      filter: {},
    });
    expect(ids(result.tickets)).toEqual(['tkt_2']);
  });

  it('filters by location after reading', async () => {
    addOpen(1, 'ASSIGNED', { location: 'Gym' });
    addOpen(2, 'ASSIGNED');
    addOpen(3, 'ASSIGNED', { location: 'Gym' });

    const result = await listTeamTickets('PLUMBING', ['ASSIGNED'], {
      limit: 5,
      after: {},
      filter: { location: 'Gym' },
    });
    expect(ids(result.tickets)).toEqual(['tkt_1', 'tkt_3']);
  });

  it('leaves out the excluded ticket and still fills the page from the others', async () => {
    addOpen(1, 'ASSIGNED');
    addOpen(2, 'ASSIGNED');
    addOpen(3, 'IN_PROGRESS');
    addOpen(4, 'ASSIGNED');

    const result = await listTeamTickets(
      'PLUMBING',
      ['ASSIGNED', 'IN_PROGRESS'],
      { limit: 2, after: {}, filter: { excludeId: 'tkt_1' } },
    );

    expect(ids(result.tickets)).toEqual(['tkt_2', 'tkt_3']);
    expect(result.next).toBeDefined();
  });

  it('resumes after the positions of a cursor', async () => {
    addOpen(1, 'ASSIGNED');
    addOpen(2, 'ASSIGNED');
    addOpen(3, 'ASSIGNED');

    const result = await listTeamTickets('PLUMBING', ['ASSIGNED'], {
      limit: 5,
      after: { ASSIGNED: '2026-11-01T08:00:00.000Z#tkt_1' },
      filter: {},
    });
    expect(ids(result.tickets)).toEqual(['tkt_2', 'tkt_3']);
  });
});

describe('listCompletedTickets', () => {
  function addDone(n: number, completedAt: string, extra: Row = {}) {
    addTicket(n, {
      status: 'DONE',
      completedAt,
      teamDoneKey: 'TEAM#PLUMBING',
      completedKey: `${completedAt}#tkt_${n}`,
      ...extra,
    });
  }

  beforeEach(() => {
    addDone(1, '2026-11-02T10:00:00.000Z');
    addDone(2, '2026-11-04T10:00:00.000Z');
    addDone(3, '2026-11-03T10:00:00.000Z');
    addDone(4, '2026-11-05T10:00:00.000Z');
    addTicket(5, {
      status: 'DONE',
      teamId: 'ELECTRICAL',
      teamDoneKey: 'TEAM#ELECTRICAL',
      completedKey: '2026-11-06T10:00:00.000Z#tkt_5',
    });
  });

  it('lists the team completed tickets, newest completion first', async () => {
    const result = await listCompletedTickets('PLUMBING', {
      limit: 10,
      filter: {},
    });

    expect(ids(result.tickets)).toEqual(['tkt_4', 'tkt_2', 'tkt_3', 'tkt_1']);
    expect(result.next).toBeUndefined();
    expect(commands('QueryCommand')[0].input).toMatchObject({
      IndexName: 'TeamDoneIndex',
      ScanIndexForward: false,
    });
  });

  it('pages through every completed ticket once', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const result = await listCompletedTickets('PLUMBING', {
        limit: 3,
        after,
        filter: {},
      });
      seen.push(...ids(result.tickets));
      after = result.next;
      pages++;
    } while (after && pages < 10);

    expect(seen).toEqual(['tkt_4', 'tkt_2', 'tkt_3', 'tkt_1']);
  });

  it('keeps to the date range, the end day included', async () => {
    const result = await listCompletedTickets('PLUMBING', {
      limit: 10,
      from: '2026-11-03T00:00:00.000Z',
      toExclusive: '2026-11-05T00:00:00.000Z',
      filter: {},
    });
    expect(ids(result.tickets)).toEqual(['tkt_2', 'tkt_3']);
  });

  it('combines a cursor with the end of the range', async () => {
    const result = await listCompletedTickets('PLUMBING', {
      limit: 10,
      after: '2026-11-04T10:00:00.000Z#tkt_2',
      toExclusive: '2026-11-05T00:00:00.000Z',
      filter: {},
    });
    expect(ids(result.tickets)).toEqual(['tkt_3', 'tkt_1']);
  });

  it('filters by location after reading', async () => {
    db.tickets.find((t) => t.ticketId === 'tkt_3')!.location = 'Gym';
    const result = await listCompletedTickets('PLUMBING', {
      limit: 10,
      filter: { location: 'Gym' },
    });
    expect(ids(result.tickets)).toEqual(['tkt_3']);
  });
});

describe('reading the tickets of a page', () => {
  it('asks again for keys DynamoDB did not process', async () => {
    addTicket(1);
    addTicket(2);
    associate(1);
    associate(2);

    const inner = send.getMockImplementation() as (c: Command) => unknown;
    let first = true;
    send.mockImplementation(async (command: Command) => {
      if (command.constructor.name === 'BatchGetCommand' && first) {
        first = false;
        return {
          Responses: { TestTickets: [db.tickets[0]] },
          UnprocessedKeys: {
            TestTickets: { Keys: [{ ticketId: 'tkt_2' }] },
          },
        };
      }
      return inner(command);
    });

    const result = await listReporterTickets('Uaaa', {
      limit: 10,
      filter: {},
    });
    expect(ids(result.tickets).sort()).toEqual(['tkt_1', 'tkt_2']);
    expect(commands('BatchGetCommand')).toHaveLength(2);
  });

  it('gives up when DynamoDB keeps throttling', async () => {
    associate(1);
    const inner = send.getMockImplementation() as (c: Command) => unknown;
    send.mockImplementation(async (command: Command) =>
      command.constructor.name === 'BatchGetCommand'
        ? {
            UnprocessedKeys: {
              TestTickets: { Keys: [{ ticketId: 'tkt_1' }] },
            },
          }
        : inner(command),
    );

    await expect(
      listReporterTickets('Uaaa', { limit: 10, filter: {} }),
    ).rejects.toThrow('throttling');
  });

  it('reads more than 100 keys in several batches', async () => {
    for (let n = 1; n <= 150; n++) {
      db.tickets.push({
        ticketId: `t${String(n).padStart(3, '0')}`,
        status: 'ASSIGNED',
        location: 'Lobby',
        teamStatusKey: 'TEAM#PLUMBING#STATUS#ASSIGNED',
        createdKey: `2026-11-01T08:00:00.${String(n).padStart(3, '0')}Z#t${n}`,
      });
    }
    const result = await listTeamTickets('PLUMBING', ['ASSIGNED'], {
      limit: 150,
      after: {},
      filter: {},
    });

    expect(result.tickets).toHaveLength(150);
    expect(commands('BatchGetCommand')).toHaveLength(2);
    for (const call of commands('BatchGetCommand')) {
      const keys = Object.values(call.input.RequestItems ?? {})[0].Keys;
      expect(keys.length).toBeLessThanOrEqual(100);
    }
  });
});
