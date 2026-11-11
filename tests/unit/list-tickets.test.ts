import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/line-token', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/line-token')
  >()),
  verifyLineToken: vi.fn(),
}));
vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  isReporterOf: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listReceivedTickets: vi.fn(),
  listReporterTickets: vi.fn(),
  listTeamTickets: vi.fn(),
  listCompletedTickets: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/list-tickets';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  listCompletedTickets,
  listReceivedTickets,
  listReporterTickets,
  listTeamTickets,
} from '../../backend/src/shared/ticket-repository';
import {
  signStaffToken,
  staffFromAuthorization,
  type StaffIdentity,
} from '../../backend/src/shared/staff-token';

const technician: StaffIdentity = {
  accountId: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 0,
};
const manager: StaffIdentity = {
  accountId: 'manager@example.com',
  role: 'MANAGER',
  tokenVersion: 0,
};

const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'ASSIGNED',
  repairCycle: 1,
  photos: [
    {
      id: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-11-05T08:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Ureporter/upl_1',
    },
  ],
  version: 4,
  reporterLineUserId: 'Ureporter',
  teamId: 'PLUMBING',
  priority: 'MEDIUM',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T08:05:00.000Z',
};

function event(
  query = '',
  who: StaffIdentity | 'reporter' | null = 'reporter',
): APIGatewayProxyEventV2 {
  const token =
    who === 'reporter' ? 'line.id.token' : who ? signStaffToken(who) : null;
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    rawQueryString: query,
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

/** A cursor as the handler would hand it out, for a given position. */
const cursorOf = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('GET /tickets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(verifyLineToken).mockResolvedValue('Ureporter');
    vi.mocked(listReporterTickets).mockResolvedValue({ tickets: [ticket] });
    vi.mocked(listTeamTickets).mockResolvedValue({ tickets: [ticket] });
    vi.mocked(listCompletedTickets).mockResolvedValue({ tickets: [ticket] });
    vi.mocked(listReceivedTickets).mockResolvedValue({ tickets: [ticket] });
  });

  describe('a reporter', () => {
    it('gets their own tickets, as views without private fields', async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
      expect(body(response)).toEqual({
        items: [
          expect.objectContaining({
            id: 'tkt_1',
            photos: [expect.objectContaining({ id: 'upl_1' })],
          }),
        ],
      });
      expect(response.body).not.toContain('Ureporter');
      expect(response.body).not.toContain('s3ObjectKey');
      expect(response.body).not.toContain('version');
      expect(listReporterTickets).toHaveBeenCalledWith('Ureporter', {
        limit: 20,
        after: undefined,
        filter: { statuses: undefined, location: undefined },
      });
    });

    it('passes the filters, with status given more than once', async () => {
      await handler(
        event('status=DONE&status=MERGED&location=Lobby%20A&limit=5'),
      );

      expect(listReporterTickets).toHaveBeenCalledWith('Ureporter', {
        limit: 5,
        after: undefined,
        filter: { statuses: ['DONE', 'MERGED'], location: 'Lobby A' },
      });
    });

    it('gets a cursor when there is more, and sends it back to continue', async () => {
      vi.mocked(listReporterTickets).mockResolvedValue({
        tickets: [ticket],
        next: '2026-11-05T08:00:00.000Z#tkt_1',
      });
      const first = await handler(event());
      const { nextCursor } = body(first);
      expect(nextCursor).toEqual(expect.any(String));

      await handler(event(`cursor=${nextCursor}`));
      expect(listReporterTickets).toHaveBeenLastCalledWith(
        'Ureporter',
        expect.objectContaining({ after: '2026-11-05T08:00:00.000Z#tkt_1' }),
      );
    });

    it('may not use the staff filters', async () => {
      for (const query of [
        'teamId=PLUMBING',
        'completedFrom=2026-11-01',
        'completedTo=2026-11-30',
      ]) {
        const response = await handler(event(query));
        expect(response.statusCode).toBe(403);
      }
      expect(listReporterTickets).not.toHaveBeenCalled();
    });

    it('is told when the LINE token is bad', async () => {
      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      const response = await handler(event());
      expect(response.statusCode).toBe(401);
      expect(listReporterTickets).not.toHaveBeenCalled();
    });
  });

  describe('a technician', () => {
    it("gets their team's open queue by default, oldest first", async () => {
      const response = await handler(event('', technician));

      expect(response.statusCode).toBe(200);
      expect(listTeamTickets).toHaveBeenCalledWith(
        'PLUMBING',
        ['ASSIGNED', 'IN_PROGRESS'],
        { limit: 20, after: {}, filter: { location: undefined } },
      );
      expect(listCompletedTickets).not.toHaveBeenCalled();
    });

    it('reads the repeated status and the team id the staff UI sends for "Team jobs"', async () => {
      await handler(
        event(
          'teamId=PLUMBING&status=ASSIGNED&status=IN_PROGRESS&limit=50',
          technician,
        ),
      );

      expect(listTeamTickets).toHaveBeenCalledWith(
        'PLUMBING',
        ['ASSIGNED', 'IN_PROGRESS'],
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('lists one open status', async () => {
      await handler(event('status=IN_PROGRESS', technician));
      expect(listTeamTickets).toHaveBeenCalledWith(
        'PLUMBING',
        ['IN_PROGRESS'],
        expect.any(Object),
      );
    });

    it('gets the completed list for status=DONE, newest first, with the date range inclusive of the last day', async () => {
      await handler(
        event(
          'status=DONE&completedFrom=2026-11-01&completedTo=2026-11-30',
          technician,
        ),
      );

      expect(listCompletedTickets).toHaveBeenCalledWith('PLUMBING', {
        limit: 20,
        after: undefined,
        from: '2026-11-01T00:00:00.000Z',
        toExclusive: '2026-12-01T00:00:00.000Z',
        filter: { location: undefined },
      });
      expect(listTeamTickets).not.toHaveBeenCalled();
    });

    it("may not list another team's tickets", async () => {
      const response = await handler(event('teamId=ELECTRICAL', technician));
      expect(response.statusCode).toBe(403);
      expect(listTeamTickets).not.toHaveBeenCalled();
    });

    it('cannot see MERGED tickets, or mix DONE with open ones', async () => {
      for (const query of ['status=MERGED', 'status=DONE&status=ASSIGNED']) {
        const response = await handler(event(query, technician));
        expect(response.statusCode).toBe(422);
      }
      expect(listTeamTickets).not.toHaveBeenCalled();
      expect(listCompletedTickets).not.toHaveBeenCalled();
    });

    it('may not list the tickets waiting for triage, alone or with others (403)', async () => {
      for (const query of [
        'status=RECEIVED',
        'status=ASSIGNED&status=RECEIVED',
        'status=RECEIVED&teamId=PLUMBING',
      ]) {
        const response = await handler(event(query, technician));
        expect(response.statusCode).toBe(403);
        expect(body(response).error.code).toBe('FORBIDDEN');
      }
      expect(listReceivedTickets).not.toHaveBeenCalled();
      expect(listTeamTickets).not.toHaveBeenCalled();
    });

    it('needs status=DONE for the completed date filters', async () => {
      const response = await handler(
        event('completedFrom=2026-11-01', technician),
      );
      expect(response.statusCode).toBe(400);
    });

    it.each([
      'completedFrom=2026-13-01',
      'completedFrom=2026-02-30',
      'completedFrom=yesterday',
      'completedTo=2026-11-1',
    ])('rejects the date in %s', async (date) => {
      const response = await handler(event(`status=DONE&${date}`, technician));
      expect(response.statusCode).toBe(400);
      expect(listCompletedTickets).not.toHaveBeenCalled();
    });

    it('continues the open queue and the completed list from their cursors', async () => {
      vi.mocked(listTeamTickets).mockResolvedValue({
        tickets: [ticket],
        next: { ASSIGNED: 'k1', IN_PROGRESS: 'k2' },
      });
      const open = body(await handler(event('', technician)));
      await handler(event(`cursor=${open.nextCursor}`, technician));
      expect(listTeamTickets).toHaveBeenLastCalledWith(
        'PLUMBING',
        ['ASSIGNED', 'IN_PROGRESS'],
        expect.objectContaining({
          after: { ASSIGNED: 'k1', IN_PROGRESS: 'k2' },
        }),
      );

      vi.mocked(listCompletedTickets).mockResolvedValue({
        tickets: [ticket],
        next: 'done-key',
      });
      const done = body(await handler(event('status=DONE', technician)));
      await handler(event(`status=DONE&cursor=${done.nextCursor}`, technician));
      expect(listCompletedTickets).toHaveBeenLastCalledWith(
        'PLUMBING',
        expect.objectContaining({ after: 'done-key' }),
      );
    });

    it('has no cursor on the last page', async () => {
      const response = await handler(event('', technician));
      expect(body(response)).not.toHaveProperty('nextCursor');
    });

    it('is checked against the account on every request', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event('', technician));
      expect(response.statusCode).toBe(401);
      expect(verifyLineToken).not.toHaveBeenCalled();
      expect(listTeamTickets).not.toHaveBeenCalled();
    });
  });

  describe('a manager', () => {
    it('lists the team named by teamId', async () => {
      const response = await handler(event('teamId=ELECTRICAL', manager));

      expect(response.statusCode).toBe(200);
      expect(listTeamTickets).toHaveBeenCalledWith(
        'ELECTRICAL',
        ['ASSIGNED', 'IN_PROGRESS'],
        expect.any(Object),
      );

      await handler(event('teamId=ELECTRICAL&status=DONE', manager));
      expect(listCompletedTickets).toHaveBeenCalledWith(
        'ELECTRICAL',
        expect.any(Object),
      );
    });

    describe('the tickets waiting for triage (status=RECEIVED)', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-12T09:00:00.000Z'));
      });
      afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });

      it('lists them oldest first from the last three months, as views without private fields', async () => {
        const response = await handler(event('status=RECEIVED', manager));

        expect(response.statusCode).toBe(200);
        expect(listReceivedTickets).toHaveBeenCalledWith(
          ['2026-09', '2026-10', '2026-11'],
          { limit: 20, after: undefined },
        );
        expect(listTeamTickets).not.toHaveBeenCalled();
        const [item] = body(response).items;
        expect(item.id).toBe('tkt_1');
        expect(item).not.toHaveProperty('reporterLineUserId');
        expect(item).not.toHaveProperty('version');
        expect(response.headers?.['cache-control']).toBe('no-store');
      });

      it('reads the number of months from TRIAGE_QUEUE_MONTHS', async () => {
        vi.stubEnv('TRIAGE_QUEUE_MONTHS', '2');
        await handler(event('status=RECEIVED', manager));
        expect(vi.mocked(listReceivedTickets).mock.calls[0][0]).toEqual([
          '2026-10',
          '2026-11',
        ]);
      });

      it('passes the limit, hands out a cursor when there is more and continues from it', async () => {
        vi.mocked(listReceivedTickets).mockResolvedValueOnce({
          tickets: [ticket],
          next: '2026-10-30T08:00:00.000Z#tkt_9',
        });
        const first = await handler(event('status=RECEIVED&limit=1', manager));
        expect(vi.mocked(listReceivedTickets).mock.calls[0][1]).toEqual({
          limit: 1,
          after: undefined,
        });
        const { nextCursor } = body(first);
        expect(
          JSON.parse(Buffer.from(nextCursor, 'base64url').toString()),
        ).toEqual({
          q: '2026-10-30T08:00:00.000Z#tkt_9',
        });

        await handler(event(`status=RECEIVED&cursor=${nextCursor}`, manager));
        expect(vi.mocked(listReceivedTickets).mock.calls[1][1]).toEqual({
          limit: 20,
          after: '2026-10-30T08:00:00.000Z#tkt_9',
        });
      });

      it('has no cursor on the last page', async () => {
        const response = await handler(event('status=RECEIVED', manager));
        expect(body(response)).not.toHaveProperty('nextCursor');
      });

      it('cannot be mixed with other statuses (422)', async () => {
        for (const query of [
          'status=RECEIVED&status=ASSIGNED',
          'status=DONE&status=RECEIVED',
        ]) {
          expect((await handler(event(query, manager))).statusCode).toBe(422);
        }
        expect(listReceivedTickets).not.toHaveBeenCalled();
      });

      it('takes no team, location or completed filter (400)', async () => {
        for (const query of [
          'status=RECEIVED&teamId=PLUMBING',
          'status=RECEIVED&location=Lobby',
          'status=RECEIVED&completedFrom=2026-11-01',
          'status=RECEIVED&completedTo=2026-11-02',
        ]) {
          expect((await handler(event(query, manager))).statusCode).toBe(400);
        }
        expect(listReceivedTickets).not.toHaveBeenCalled();
      });

      it('rejects a cursor of another list (400)', async () => {
        const response = await handler(
          event(`status=RECEIVED&cursor=${cursorOf({ o: {} })}`, manager),
        );
        expect(response.statusCode).toBe(400);
      });

      it('answers 500 without details when the read fails', async () => {
        vi.mocked(listReceivedTickets).mockRejectedValue(
          new Error('index gone: secret'),
        );
        const response = await handler(event('status=RECEIVED', manager));
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('secret');
      });
    });

    it('must name a real team', async () => {
      for (const query of ['', 'teamId=NOPE']) {
        const response = await handler(event(query, manager));
        expect(response.statusCode).toBe(400);
      }
      expect(listTeamTickets).not.toHaveBeenCalled();
    });
  });

  describe('a bad query', () => {
    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=2.5',
      'limit=-1',
      'limit=5&limit=6',
      'location=a&location=b',
      'status=OPEN',
      'sort=asc',
      'cursor=not-a-cursor',
      `cursor=${cursorOf('text')}`,
      `cursor=${cursorOf({ r: 5 })}`,
      `cursor=${cursorOf({ x: 'k' })}`,
      `cursor=${'a'.repeat(1001)}`,
    ])('answers 400 for %s', async (query) => {
      const response = await handler(event(query, technician));
      expect(response.statusCode).toBe(400);
      expect(listTeamTickets).not.toHaveBeenCalled();
    });

    it('rejects a cursor of the wrong kind for the list', async () => {
      const response = await handler(
        event(`cursor=${cursorOf({ r: 'x' })}`, technician),
      );
      expect(response.statusCode).toBe(400);

      const reporter = await handler(
        event(`cursor=${cursorOf({ o: { ASSIGNED: 'k' } })}`),
      );
      expect(reporter.statusCode).toBe(400);
      expect(listReporterTickets).not.toHaveBeenCalled();
    });

    it('checks who is asking before the query', async () => {
      const response = await handler(event('limit=0', null));
      expect(response.statusCode).toBe(401);
    });
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(listTeamTickets).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event('', technician));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
