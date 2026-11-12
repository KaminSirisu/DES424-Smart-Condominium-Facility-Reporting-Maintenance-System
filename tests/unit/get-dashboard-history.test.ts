import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listTicketsOfMonths: vi.fn(),
  attachPhotos: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/get-dashboard-history';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  attachPhotos,
  listTicketsOfMonths,
} from '../../backend/src/shared/ticket-repository';
import {
  signStaffToken,
  staffFromAuthorization,
  type StaffIdentity,
} from '../../backend/src/shared/staff-token';

const manager: StaffIdentity = {
  accountId: 'manager@example.com',
  role: 'MANAGER',
  tokenVersion: 0,
};
const technician: StaffIdentity = {
  accountId: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 0,
};

const NOW = new Date('2026-11-11T08:00:00.000Z');

function ticket(
  id: string,
  createdAt: string,
  overrides: Partial<TicketRecord> = {},
): TicketRecord {
  return {
    id,
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 3,
    reporterLineUserId: 'Ureporter',
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

/** Newest first, as the month index gives them. */
const all: TicketRecord[] = [
  ticket('t5', '2026-11-09T08:00:00.000Z', {
    location: 'Gym',
    teamId: 'HVAC',
    priority: 'LOW',
  }),
  ticket('t4', '2026-11-05T08:00:00.000Z', {
    status: 'DONE',
    repairCycle: 2,
    completedAt: '2026-11-06T08:00:00.000Z',
    lastCompletedAt: '2026-11-06T08:00:00.000Z',
  }),
  ticket('t3', '2026-10-30T23:59:59.999Z', {
    status: 'RECEIVED',
    teamId: undefined,
    priority: undefined,
  }),
  ticket('t2', '2026-10-30T00:00:00.000Z', { location: 'Gym' }),
  ticket('t1', '2026-10-01T08:00:00.000Z', { status: 'MERGED' }),
];

function event(
  query = '',
  who: StaffIdentity | null = manager,
): APIGatewayProxyEventV2 {
  return {
    headers: who ? { authorization: `Bearer ${signStaffToken(who)}` } : {},
    rawQueryString: query,
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

const cursorOf = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const ids = (response: { body?: string }) =>
  body(response).items.map((e: { ticket: { id: string } }) => e.ticket.id);

describe('GET /dashboard/history', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.unstubAllEnvs();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(listTicketsOfMonths).mockResolvedValue(all);
    vi.mocked(attachPhotos).mockImplementation(async (tickets) => tickets);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('the answer', () => {
    it('lists the tickets newest first with their repair counts, and totals over all of them', async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
      expect(ids(response)).toEqual(['t5', 't4', 't3', 't2', 't1']);
      expect(body(response).items[1]).toMatchObject({
        ticket: { id: 't4', status: 'DONE' },
        completionCount: 2,
        reopenCount: 1,
        lastCompletedAt: '2026-11-06T08:00:00.000Z',
      });
      expect(body(response).summary).toMatchObject({
        totalTickets: 5,
        countsByStatus: {
          RECEIVED: 1,
          ASSIGNED: 2,
          IN_PROGRESS: 0,
          DONE: 1,
          MERGED: 1,
        },
        countsByPriority: { LOW: 1, MEDIUM: 3 },
        countsByTeam: { HVAC: 1, PLUMBING: 3 },
        completionCount: 2,
        reopenCount: 1,
      });
      expect(body(response).generatedAt).toBe('2026-11-11T08:00:00.000Z');
      expect(body(response)).not.toHaveProperty('nextCursor');
    });

    it('groups the locations in the summary', async () => {
      const { summary } = body(await handler(event()));
      expect(summary.locationBreakdown).toEqual([
        { location: 'Lobby', reportedCount: 3, completedCount: 1 },
        { location: 'Gym', reportedCount: 2, completedCount: 0 },
      ]);
    });

    it('shows no private field of a ticket', async () => {
      const response = await handler(event());
      expect(response.body).not.toContain('Ureporter');
      expect(response.body).not.toContain('version');
    });
  });

  describe('the months it reads', () => {
    it('reads the last 24 months, or as many as DASHBOARD_MAX_MONTHS says', async () => {
      await handler(event());
      const months = vi.mocked(listTicketsOfMonths).mock.calls[0][0];
      expect(months).toHaveLength(24);
      expect(months[0]).toBe('2026-11');

      vi.stubEnv('DASHBOARD_MAX_MONTHS', '2');
      await handler(event());
      expect(vi.mocked(listTicketsOfMonths).mock.calls[1][0]).toEqual([
        '2026-11',
        '2026-10',
      ]);
    });

    it('narrows the months to from and to', async () => {
      await handler(event('from=2026-09-15&to=2026-10-31'));
      expect(vi.mocked(listTicketsOfMonths).mock.calls[0][0]).toEqual([
        '2026-10',
        '2026-09',
      ]);
    });

    it('does not read months after the current one', async () => {
      await handler(event('to=2027-03-01'));
      expect(vi.mocked(listTicketsOfMonths).mock.calls[0][0][0]).toBe(
        '2026-11',
      );
    });

    it('answers 400 for a from older than the months the report covers, and says where it starts', async () => {
      const response = await handler(event('from=2024-11-30'));
      expect(response.statusCode).toBe(400);
      expect(body(response).error.message).toContain('2024-12');
      expect(listTicketsOfMonths).not.toHaveBeenCalled();
    });

    it('accepts a from in the oldest month it covers', async () => {
      const response = await handler(event('from=2024-12-01'));
      expect(response.statusCode).toBe(200);
    });

    it('answers an empty report for a period before the first month it covers, without reading', async () => {
      const response = await handler(event('to=2024-06-30'));
      expect(response.statusCode).toBe(200);
      expect(body(response).items).toEqual([]);
      expect(body(response).summary.totalTickets).toBe(0);
      expect(vi.mocked(listTicketsOfMonths).mock.calls[0][0]).toEqual([]);
    });
  });

  describe('the filters', () => {
    it('keeps the tickets created from the start of from to the end of to, both days included', async () => {
      const response = await handler(event('from=2026-10-30&to=2026-10-30'));
      expect(ids(response)).toEqual(['t3', 't2']);
      expect(body(response).summary.totalTickets).toBe(2);
    });

    it('includes the very start of from and leaves out the very start of the day after to', async () => {
      vi.mocked(listTicketsOfMonths).mockResolvedValue([
        ticket('after', '2026-10-31T00:00:00.000Z'),
        ticket('last', '2026-10-30T23:59:59.999Z'),
        ticket('first', '2026-10-30T00:00:00.000Z'),
        ticket('before', '2026-10-29T23:59:59.999Z'),
      ]);

      const response = await handler(event('from=2026-10-30&to=2026-10-30'));

      expect(ids(response)).toEqual(['last', 'first']);
    });

    it('filters by status, by the exact location and by team, and counts only what matches', async () => {
      expect(ids(await handler(event('status=DONE')))).toEqual(['t4']);
      expect(ids(await handler(event('location=Gym')))).toEqual(['t5', 't2']);
      expect(ids(await handler(event('location=gym')))).toEqual([]);
      expect(ids(await handler(event('teamId=HVAC')))).toEqual(['t5']);

      const gym = body(await handler(event('location=Gym')));
      expect(gym.summary.totalTickets).toBe(2);
      expect(gym.summary.locationBreakdown).toEqual([
        { location: 'Gym', reportedCount: 2, completedCount: 0 },
      ]);
    });

    it('combines the filters', async () => {
      const response = await handler(
        event('teamId=PLUMBING&status=ASSIGNED&from=2026-10-01'),
      );
      expect(ids(response)).toEqual(['t2']);
    });

    it.each([
      'status=OPEN',
      'status=DONE&status=MERGED',
      'teamId=NOPE',
      'teamId=hvac',
      'from=2026-13-01',
      'from=2026-02-30',
      'to=yesterday',
      'from=2026-11-10&to=2026-11-01',
      'location=a&location=b',
      'sort=asc',
    ])('answers 400 for %s', async (query) => {
      const response = await handler(event(query));
      expect(response.statusCode).toBe(400);
      expect(listTicketsOfMonths).not.toHaveBeenCalled();
    });
  });

  describe('paging', () => {
    it('gives a page, a cursor while there are more, and the totals of all of them on every page', async () => {
      const first = await handler(event('limit=2'));
      expect(ids(first)).toEqual(['t5', 't4']);
      expect(body(first).summary.totalTickets).toBe(5);
      expect(body(first).nextCursor).toEqual(expect.any(String));

      const second = await handler(
        event(`limit=2&cursor=${body(first).nextCursor}`),
      );
      expect(ids(second)).toEqual(['t3', 't2']);
      expect(body(second).summary.totalTickets).toBe(5);

      const third = await handler(
        event(`limit=2&cursor=${body(second).nextCursor}`),
      );
      expect(ids(third)).toEqual(['t1']);
      expect(body(third)).not.toHaveProperty('nextCursor');
    });

    it('has no cursor when the last page is exactly full', async () => {
      const response = await handler(event('limit=5'));
      expect(ids(response)).toHaveLength(5);
      expect(body(response)).not.toHaveProperty('nextCursor');
    });

    it('loads the photos of the page only', async () => {
      await handler(event('limit=2'));
      const given = vi.mocked(attachPhotos).mock.calls[0][0];
      expect(given.map((t) => t.id)).toEqual(['t5', 't4']);
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=5&limit=6',
      'cursor=not-a-cursor',
      `cursor=${cursorOf('text')}`,
      `cursor=${cursorOf({ o: 'x' })}`,
      `cursor=${cursorOf({ h: 5 })}`,
      `cursor=${'a'.repeat(1001)}`,
    ])('answers 400 for %s', async (query) => {
      const response = await handler(event(query));
      expect(response.statusCode).toBe(400);
      expect(listTicketsOfMonths).not.toHaveBeenCalled();
    });
  });

  describe('who may read it', () => {
    it('answers 403 to a technician and reads nothing', async () => {
      const response = await handler(event('', technician));
      expect(response.statusCode).toBe(403);
      expect(listTicketsOfMonths).not.toHaveBeenCalled();
    });

    it('answers 401 for a token that is not a current staff token, such as a reporter', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      expect((await handler(event())).statusCode).toBe(401);
    });

    it('needs a token', async () => {
      vi.mocked(requireStaff).mockImplementation(async (authorization) =>
        staffFromAuthorization(authorization),
      );
      expect((await handler(event('', null))).statusCode).toBe(401);
    });
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(listTicketsOfMonths).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
