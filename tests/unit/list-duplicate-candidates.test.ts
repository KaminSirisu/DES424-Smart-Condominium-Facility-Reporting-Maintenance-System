import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  isReporterOf: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  listTeamTickets: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/list-duplicate-candidates';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  getTicket,
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
const otherTeam: StaffIdentity = {
  accountId: 'electrical@example.com',
  role: 'TECHNICIAN',
  teamId: 'ELECTRICAL',
  tokenVersion: 0,
};
const manager: StaffIdentity = {
  accountId: 'manager@example.com',
  role: 'MANAGER',
  tokenVersion: 0,
};

function make(id: string, overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id,
    location: 'Beside the lobby elevator',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [
      {
        id: `upl_${id}`,
        purpose: 'DEFECT',
        addedAt: '2026-11-05T08:00:00.000Z',
        s3ObjectKey: `uploads/DEFECT/U${id}/upl_${id}`,
      },
    ],
    version: 3,
    reporterLineUserId: `Ureporter_${id}`,
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
    ...overrides,
  };
}

const ticket = make('tkt_1');
const candidate = make('tkt_2');

function event(
  query = '',
  who: StaffIdentity | null = technician,
  ticketId: string | null = 'tkt_1',
): APIGatewayProxyEventV2 {
  return {
    headers: who ? { authorization: `Bearer ${signStaffToken(who)}` } : {},
    rawQueryString: query,
    pathParameters: ticketId === null ? {} : { ticketId },
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

const cursorOf = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('GET /tickets/{ticketId}/duplicates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(listTeamTickets).mockResolvedValue({ tickets: [candidate] });
  });

  describe('the matching rule', () => {
    it('asks for open tickets of the same team with exactly the same location, without the ticket itself', async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(listTeamTickets).toHaveBeenCalledWith(
        'PLUMBING',
        ['ASSIGNED', 'IN_PROGRESS'],
        {
          limit: 20,
          after: {},
          filter: {
            location: 'Beside the lobby elevator',
            excludeId: 'tkt_1',
          },
        },
      );
      expect(body(response)).toEqual({
        items: [
          expect.objectContaining({
            id: 'tkt_2',
            status: 'ASSIGNED',
            location: 'Beside the lobby elevator',
            photos: [expect.objectContaining({ id: 'upl_tkt_2' })],
          }),
        ],
      });
    });

    it('passes the location text unchanged, spaces and letter case included', async () => {
      vi.mocked(getTicket).mockResolvedValue(
        make('tkt_1', { location: '  Gym, Floor 2  ' }),
      );
      await handler(event());
      expect(vi.mocked(listTeamTickets).mock.calls[0][2].filter).toEqual({
        location: '  Gym, Floor 2  ',
        excludeId: 'tkt_1',
      });
    });

    it('gives candidates for an IN_PROGRESS ticket too', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'IN_PROGRESS',
      });
      await handler(event());
      expect(listTeamTickets).toHaveBeenCalledOnce();
    });

    it('shows no private field of a candidate', async () => {
      const response = await handler(event());
      for (const hidden of [
        'Ureporter_tkt_2',
        's3ObjectKey',
        'uploads/',
        'version',
      ]) {
        expect(response.body).not.toContain(hidden);
      }
    });

    it('is never cached', async () => {
      const response = await handler(event());
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
    });
  });

  describe('a ticket that is not open', () => {
    it.each(['RECEIVED', 'DONE', 'MERGED'] as const)(
      'has no candidates when it is %s: an empty page, not an error',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({
          ...ticket,
          status,
          ...(status === 'RECEIVED' ? { teamId: undefined } : {}),
        });

        const response = await handler(event('', manager));

        expect(response.statusCode).toBe(200);
        expect(body(response)).toEqual({ items: [] });
        expect(listTeamTickets).not.toHaveBeenCalled();
      },
    );
  });

  describe('who may ask', () => {
    it('lets a manager ask about a ticket of any team', async () => {
      const response = await handler(event('', manager));
      expect(response.statusCode).toBe(200);
      expect(listTeamTickets).toHaveBeenCalledWith(
        'PLUMBING',
        expect.any(Array),
        expect.any(Object),
      );
    });

    it('answers 403 to a technician of another team', async () => {
      const response = await handler(event('', otherTeam));
      expect(response.statusCode).toBe(403);
      expect(listTeamTickets).not.toHaveBeenCalled();
    });

    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      expect((await handler(event())).statusCode).toBe(404);
    });

    it('answers 401 for a token that is not a current staff token, such as a reporter', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event());
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('needs a token', async () => {
      expect((await handler(event('', null))).statusCode).toBe(401);
    });
  });

  describe('paging', () => {
    it('passes limit, and hands out a cursor only when there may be more', async () => {
      vi.mocked(listTeamTickets).mockResolvedValue({
        tickets: [candidate],
        next: { ASSIGNED: 'k1', IN_PROGRESS: 'k2' },
      });
      const first = body(await handler(event('limit=5')));
      expect(vi.mocked(listTeamTickets).mock.calls[0][2].limit).toBe(5);
      expect(first.nextCursor).toEqual(expect.any(String));

      vi.mocked(listTeamTickets).mockResolvedValue({ tickets: [] });
      const last = body(
        await handler(event(`cursor=${first.nextCursor}&limit=5`)),
      );
      expect(vi.mocked(listTeamTickets).mock.calls[1][2].after).toEqual({
        ASSIGNED: 'k1',
        IN_PROGRESS: 'k2',
      });
      expect(last).not.toHaveProperty('nextCursor');
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=5&limit=6',
      'status=ASSIGNED',
      'location=Lobby',
      'cursor=not-a-cursor',
      `cursor=${cursorOf('text')}`,
      `cursor=${cursorOf({ r: 'x' })}`,
      `cursor=${cursorOf({ o: { ASSIGNED: 5 } })}`,
      `cursor=${'a'.repeat(1001)}`,
    ])('answers 400 for %s', async (query) => {
      const response = await handler(event(query));
      expect(response.statusCode).toBe(400);
      expect(listTeamTickets).not.toHaveBeenCalled();
    });
  });

  it('answers 400 when the ticket id is missing', async () => {
    const response = await handler(event('', technician, null));
    expect(response.statusCode).toBe(400);
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(listTeamTickets).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
