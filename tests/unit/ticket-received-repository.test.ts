import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  listAllReceivedTickets,
  listReceivedTickets,
} from '../../backend/src/shared/ticket-repository.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

interface Row {
  ticketId: string;
  createdMonth: string;
  createdKey: string;
  status: string;
  [key: string]: unknown;
}

/** An in-memory stand-in for CreatedMonthIndex, BatchGet and the photo query. */
let rows: Row[] = [];
/** Rows per Query page, to make the reads follow LastEvaluatedKey. */
let pageSize = 1000;

interface Command {
  constructor: { name: string };
  input: {
    IndexName?: string;
    KeyConditionExpression?: string;
    FilterExpression?: string;
    ExclusiveStartKey?: { createdKey: string };
    ExpressionAttributeValues?: Record<string, string>;
    RequestItems?: Record<string, { Keys: { ticketId: string }[] }>;
  };
}

function ticketRow(
  id: string,
  createdAt: string,
  status = 'RECEIVED',
  extra: Record<string, unknown> = {},
): Row {
  return {
    ticketId: id,
    createdMonth: createdAt.slice(0, 7),
    createdKey: `${createdAt}#${id}`,
    location: 'Lobby',
    description: 'Something is wrong.',
    status,
    repairCycle: 1,
    version: 1,
    reporterLineUserId: 'Ureporter',
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

const queries = () =>
  send.mock.calls
    .map((c) => c[0] as Command)
    .filter((c) => c.input.IndexName === 'CreatedMonthIndex');

function fakeDynamo() {
  send.mockImplementation(async (command: Command) => {
    const { input } = command;
    if (command.constructor.name === 'BatchGetCommand') {
      const [table, request] = Object.entries(input.RequestItems ?? {})[0];
      const ids = request.Keys.map((k) => k.ticketId);
      return {
        Responses: { [table]: rows.filter((r) => ids.includes(r.ticketId)) },
      };
    }
    if (input.IndexName === 'CreatedMonthIndex') {
      const v = input.ExpressionAttributeValues ?? {};
      let matching = rows
        .filter((r) => r.createdMonth === v[':month'])
        .sort((a, b) => (a.createdKey < b.createdKey ? -1 : 1));
      if (input.KeyConditionExpression?.includes('createdKey > :after')) {
        matching = matching.filter((r) => r.createdKey > v[':after']);
      }
      const start = input.ExclusiveStartKey?.createdKey;
      if (start) matching = matching.filter((r) => r.createdKey > start);
      const slice = matching.slice(0, pageSize);
      const more = matching.length > pageSize;
      // The filter applies after the read, like DynamoDB.
      const items = input.FilterExpression
        ? slice.filter((r) => r.status === v[':received'])
        : slice;
      return {
        Items: items,
        ...(more
          ? {
              LastEvaluatedKey: {
                createdKey: slice[slice.length - 1].createdKey,
              },
            }
          : {}),
      };
    }
    // The photo query of loadTickets.
    return { Items: [] };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_PHOTOS_TABLE_NAME', 'TestPhotos');
  rows = [];
  pageSize = 1000;
  fakeDynamo();
});
afterEach(() => vi.unstubAllEnvs());

const MONTHS = ['2026-09', '2026-10', '2026-11'];

describe('listReceivedTickets', () => {
  it('asks CreatedMonthIndex for each month, oldest first, filtered on RECEIVED', async () => {
    await listReceivedTickets(MONTHS, { limit: 20 });

    expect(
      queries().map((q) => q.input.ExpressionAttributeValues?.[':month']),
    ).toEqual(MONTHS);
    for (const q of queries()) {
      expect(q.input).toMatchObject({
        TableName: 'TestTickets',
        IndexName: 'CreatedMonthIndex',
        FilterExpression: '#status = :received',
        ExpressionAttributeNames: { '#status': 'status' },
      });
      expect(q.input.ExpressionAttributeValues).toMatchObject({
        ':received': 'RECEIVED',
      });
    }
  });

  it('returns the waiting tickets across months in creation order, and leaves the others out', async () => {
    rows = [
      ticketRow('tkt_c', '2026-11-02T08:00:00.000Z'),
      ticketRow('tkt_a', '2026-09-15T08:00:00.000Z'),
      ticketRow('tkt_done', '2026-10-01T08:00:00.000Z', 'DONE'),
      ticketRow('tkt_b', '2026-10-20T08:00:00.000Z'),
      ticketRow('tkt_assigned', '2026-10-21T08:00:00.000Z', 'ASSIGNED'),
    ];

    const page = await listReceivedTickets(MONTHS, { limit: 20 });

    expect(page.tickets.map((t) => t.id)).toEqual(['tkt_a', 'tkt_b', 'tkt_c']);
    expect(page.next).toBeUndefined();
    // Records, not items: no index keys, an id and the photos.
    expect(page.tickets[0]).toMatchObject({ id: 'tkt_a', photos: [] });
    expect(page.tickets[0]).not.toHaveProperty('createdKey');
    expect(page.tickets[0]).not.toHaveProperty('ticketId');
  });

  it('gives a page of `limit`, with a cursor only when there is more', async () => {
    rows = [
      ticketRow('tkt_1', '2026-09-01T08:00:00.000Z'),
      ticketRow('tkt_2', '2026-10-01T08:00:00.000Z'),
      ticketRow('tkt_3', '2026-11-01T08:00:00.000Z'),
    ];

    const first = await listReceivedTickets(MONTHS, { limit: 2 });
    expect(first.tickets.map((t) => t.id)).toEqual(['tkt_1', 'tkt_2']);
    expect(first.next).toBe('2026-10-01T08:00:00.000Z#tkt_2');

    const second = await listReceivedTickets(MONTHS, {
      limit: 2,
      after: first.next,
    });
    expect(second.tickets.map((t) => t.id)).toEqual(['tkt_3']);
    expect(second.next).toBeUndefined();

    const exact = await listReceivedTickets(MONTHS, { limit: 3 });
    expect(exact.tickets).toHaveLength(3);
    expect(exact.next).toBeUndefined();
  });

  it('continues inside the month of the cursor and skips the months before it', async () => {
    rows = [
      ticketRow('tkt_1', '2026-09-01T08:00:00.000Z'),
      ticketRow('tkt_2', '2026-10-01T08:00:00.000Z'),
      ticketRow('tkt_3', '2026-10-09T08:00:00.000Z'),
      ticketRow('tkt_4', '2026-11-01T08:00:00.000Z'),
    ];
    send.mockClear();

    const page = await listReceivedTickets(MONTHS, {
      limit: 20,
      after: '2026-10-01T08:00:00.000Z#tkt_2',
    });

    expect(page.tickets.map((t) => t.id)).toEqual(['tkt_3', 'tkt_4']);
    const asked = queries();
    expect(
      asked.map((q) => q.input.ExpressionAttributeValues?.[':month']),
    ).toEqual(['2026-10', '2026-11']);
    expect(asked[0].input.KeyConditionExpression).toBe(
      'createdMonth = :month AND createdKey > :after',
    );
    expect(asked[0].input.ExpressionAttributeValues).toMatchObject({
      ':after': '2026-10-01T08:00:00.000Z#tkt_2',
    });
    // The following month starts from its beginning.
    expect(asked[1].input.KeyConditionExpression).toBe('createdMonth = :month');
  });

  it('follows the pages of the index until it has enough', async () => {
    pageSize = 2;
    rows = [
      ticketRow('tkt_1', '2026-10-01T08:00:00.000Z', 'DONE'),
      ticketRow('tkt_2', '2026-10-02T08:00:00.000Z', 'DONE'),
      ticketRow('tkt_3', '2026-10-03T08:00:00.000Z', 'DONE'),
      ticketRow('tkt_4', '2026-10-04T08:00:00.000Z'),
      ticketRow('tkt_5', '2026-10-05T08:00:00.000Z'),
    ];

    const page = await listReceivedTickets(['2026-10'], { limit: 2 });

    expect(page.tickets.map((t) => t.id)).toEqual(['tkt_4', 'tkt_5']);
    expect(queries().length).toBeGreaterThan(1);
  });

  it('does not read more months than it needs for a full page', async () => {
    rows = [
      ticketRow('tkt_1', '2026-09-01T08:00:00.000Z'),
      ticketRow('tkt_2', '2026-09-02T08:00:00.000Z'),
      ticketRow('tkt_3', '2026-09-03T08:00:00.000Z'),
      ticketRow('tkt_4', '2026-11-01T08:00:00.000Z'),
    ];
    await listReceivedTickets(MONTHS, { limit: 1 });
    expect(queries()).toHaveLength(1);
  });

  it('leaves out a ticket that was triaged after the index was read', async () => {
    rows = [
      ticketRow('tkt_1', '2026-10-01T08:00:00.000Z'),
      ticketRow('tkt_2', '2026-10-02T08:00:00.000Z'),
    ];
    const real = send.getMockImplementation() as (
      c: Command,
    ) => Promise<unknown>;
    send.mockImplementation(async (command: Command) => {
      if (command.constructor.name === 'BatchGetCommand') {
        rows = rows.map((r) =>
          r.ticketId === 'tkt_1' ? { ...r, status: 'ASSIGNED' } : r,
        );
      }
      return real(command);
    });

    const page = await listReceivedTickets(['2026-10'], { limit: 20 });
    expect(page.tickets.map((t) => t.id)).toEqual(['tkt_2']);
  });

  it('is empty when nothing waits', async () => {
    await expect(listReceivedTickets(MONTHS, { limit: 20 })).resolves.toEqual({
      tickets: [],
    });
  });
});

describe('listAllReceivedTickets', () => {
  it('returns every waiting ticket of the months, oldest first, from the index alone', async () => {
    rows = [
      ticketRow('tkt_b', '2026-10-20T08:00:00.000Z'),
      ticketRow('tkt_x', '2026-10-21T08:00:00.000Z', 'ASSIGNED'),
      ticketRow('tkt_a', '2026-09-15T08:00:00.000Z'),
      ticketRow('tkt_old', '2026-05-15T08:00:00.000Z'),
    ];

    const tickets = await listAllReceivedTickets(MONTHS);

    expect(tickets.map((t) => t.id)).toEqual(['tkt_a', 'tkt_b']);
    expect(tickets[0]).toMatchObject({
      id: 'tkt_a',
      status: 'RECEIVED',
      photos: [],
    });
    expect(tickets[0]).not.toHaveProperty('createdKey');
    // Nothing else was read: no BatchGet, no photo query.
    const names = send.mock.calls.map(
      (c) => (c[0] as Command).constructor.name,
    );
    expect(names.every((n) => n === 'QueryCommand')).toBe(true);
    expect(queries()).toHaveLength(3);
  });

  it('follows the pages of a month', async () => {
    pageSize = 1;
    rows = [
      ticketRow('tkt_1', '2026-10-01T08:00:00.000Z'),
      ticketRow('tkt_2', '2026-10-02T08:00:00.000Z'),
      ticketRow('tkt_3', '2026-10-03T08:00:00.000Z'),
    ];
    const tickets = await listAllReceivedTickets(['2026-10']);
    expect(tickets.map((t) => t.id)).toEqual(['tkt_1', 'tkt_2', 'tkt_3']);
  });
});
