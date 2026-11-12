import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  attachPhotos,
  listTicketsOfMonths,
} from '../../backend/src/shared/ticket-repository.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, string | number>;

interface Command {
  input: {
    TableName: string;
    IndexName?: string;
    ScanIndexForward?: boolean;
    ExclusiveStartKey?: Record<string, string>;
    ExpressionAttributeValues: Record<string, string>;
  };
}

let tickets: Row[] = [];
let photos: Row[] = [];
const PAGE = 2;

/** The month index in pages of PAGE items, and the photo table. */
function fakeDynamo() {
  send.mockImplementation(async (command: Command) => {
    const { input } = command;
    const v = input.ExpressionAttributeValues;
    if (input.IndexName === 'CreatedMonthIndex') {
      const rows = tickets
        .filter((t) => t.createdMonth === v[':month'])
        .sort((a, b) =>
          String(b.createdKey).localeCompare(String(a.createdKey)),
        );
      const start = input.ExclusiveStartKey
        ? rows.findIndex(
            (r) => r.createdKey === input.ExclusiveStartKey?.createdKey,
          ) + 1
        : 0;
      const items = rows.slice(start, start + PAGE);
      return {
        Items: items,
        ...(start + PAGE < rows.length
          ? {
              LastEvaluatedKey: {
                createdKey: items[items.length - 1].createdKey,
              },
            }
          : {}),
      };
    }
    return { Items: photos.filter((p) => p.ticketId === v[':ticketId']) };
  });
}

function ticket(n: number, month = '2026-11'): Row {
  const createdAt = `${month}-0${n}T08:00:00.000Z`;
  return {
    ticketId: `tkt_${month}_${n}`,
    createdMonth: month,
    createdKey: `${createdAt}#tkt_${month}_${n}`,
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    version: 2,
    reporterLineUserId: 'Uaaa',
    teamId: 'PLUMBING',
    teamStatusKey: 'TEAM#PLUMBING#STATUS#ASSIGNED',
    createdAt,
    updatedAt: createdAt,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_PHOTOS_TABLE_NAME', 'TestPhotos');
  tickets = [];
  photos = [];
  fakeDynamo();
});
afterEach(() => vi.unstubAllEnvs());

describe('listTicketsOfMonths', () => {
  it('reads every ticket of the months from the month index, months in the order given, newest first inside a month', async () => {
    tickets = [
      ticket(1, '2026-10'),
      ticket(2, '2026-11'),
      ticket(1, '2026-11'),
    ];

    const result = await listTicketsOfMonths(['2026-11', '2026-10']);

    expect(result.map((t) => t.id)).toEqual([
      'tkt_2026-11_2',
      'tkt_2026-11_1',
      'tkt_2026-10_1',
    ]);
    const first = send.mock.calls[0][0].input;
    expect(first).toMatchObject({
      TableName: 'TestTickets',
      IndexName: 'CreatedMonthIndex',
      KeyConditionExpression: 'createdMonth = :month',
      ScanIndexForward: false,
    });
  });

  it('follows the index across pages of a busy month', async () => {
    tickets = [1, 2, 3, 4, 5].map((n) => ticket(n));

    const result = await listTicketsOfMonths(['2026-11']);

    expect(result.map((t) => t.id)).toEqual([
      'tkt_2026-11_5',
      'tkt_2026-11_4',
      'tkt_2026-11_3',
      'tkt_2026-11_2',
      'tkt_2026-11_1',
    ]);
    // 3 pages of at most 2 tickets
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives the tickets as records, without storage attributes and without photos', async () => {
    tickets = [ticket(1)];

    const [record] = await listTicketsOfMonths(['2026-11']);

    expect(record).toMatchObject({
      id: 'tkt_2026-11_1',
      status: 'ASSIGNED',
      teamId: 'PLUMBING',
      photos: [],
    });
    for (const stored of [
      'ticketId',
      'createdMonth',
      'createdKey',
      'teamStatusKey',
    ]) {
      expect(record).not.toHaveProperty(stored);
    }
    // no photo was read
    expect(send.mock.calls.every((c) => c[0].input.IndexName)).toBe(true);
  });

  it('is empty for no months and for months with no tickets', async () => {
    await expect(listTicketsOfMonths([])).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
    await expect(listTicketsOfMonths(['2026-09'])).resolves.toEqual([]);
  });

  it('fails clearly when the table name is not set', async () => {
    vi.stubEnv('TICKETS_TABLE_NAME', '');
    await expect(listTicketsOfMonths(['2026-11'])).rejects.toThrow(
      'TICKETS_TABLE_NAME environment variable is not set.',
    );
  });
});

describe('attachPhotos', () => {
  it('adds the photos of each ticket, reading only the tickets it is given', async () => {
    tickets = [ticket(1), ticket(2)];
    photos = [
      {
        ticketId: 'tkt_2026-11_2',
        photoId: 'upl_1',
        purpose: 'DEFECT',
        addedAt: '2026-11-02T08:00:00.000Z',
        s3ObjectKey: 'uploads/DEFECT/Uaaa/upl_1',
      },
    ];
    const read = await listTicketsOfMonths(['2026-11']);
    send.mockClear();

    const result = await attachPhotos([read[0]]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tkt_2026-11_2');
    expect(result[0].photos).toEqual([
      {
        id: 'upl_1',
        purpose: 'DEFECT',
        addedAt: '2026-11-02T08:00:00.000Z',
        s3ObjectKey: 'uploads/DEFECT/Uaaa/upl_1',
      },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives an empty list for a ticket without photos, and nothing for no tickets', async () => {
    tickets = [ticket(1)];
    const [one] = await listTicketsOfMonths(['2026-11']);
    expect((await attachPhotos([one]))[0].photos).toEqual([]);
    await expect(attachPhotos([])).resolves.toEqual([]);
  });
});
