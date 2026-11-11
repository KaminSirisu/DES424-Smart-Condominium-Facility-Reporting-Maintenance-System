import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  ApiError,
  type TicketEventRecord,
  type TicketRecord,
} from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  isReporterOf: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  listTicketEvents: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/list-ticket-events';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  getTicket,
  listTicketEvents,
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

const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'DONE',
  repairCycle: 1,
  photos: [],
  version: 6,
  reporterLineUserId: 'Ureporter',
  teamId: 'PLUMBING',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
};

const events: TicketEventRecord[] = [
  {
    id: 'tkt_1_created',
    ticketId: 'tkt_1',
    kind: 'CREATED',
    occurredAt: '2026-11-05T08:00:00.000Z',
    actorType: 'REPORTER',
    toStatus: 'RECEIVED',
  },
  {
    id: 'tkt_1_status_v3',
    ticketId: 'tkt_1',
    kind: 'STATUS_CHANGED',
    occurredAt: '2026-11-05T11:00:00.000Z',
    actorType: 'STAFF',
    actorStaffId: 'plumbing@example.com',
    actorTeamId: 'PLUMBING',
    fromStatus: 'IN_PROGRESS',
    toStatus: 'DONE',
    proofPhotoId: 'upl_proof',
  },
];

function event(
  query = '',
  who: StaffIdentity | 'reporter' | null = technician,
  ticketId: string | null = 'tkt_1',
): APIGatewayProxyEventV2 {
  const token =
    who === 'reporter' ? 'line.id.token' : who ? signStaffToken(who) : null;
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
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

describe('GET /tickets/{ticketId}/events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) => {
      const identity = staffFromAuthorization(authorization);
      return identity;
    });
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(listTicketEvents).mockResolvedValue({ events });
  });

  describe('who may read the history', () => {
    it("lets a technician read their team's ticket", async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
      expect(body(response)).toEqual({
        items: [
          expect.objectContaining({ id: 'tkt_1_created', kind: 'CREATED' }),
          expect.objectContaining({
            id: 'tkt_1_status_v3',
            kind: 'STATUS_CHANGED',
            actorStaffId: 'plumbing@example.com',
            actorTeamId: 'PLUMBING',
            proofPhotoId: 'upl_proof',
          }),
        ],
      });
      expect(listTicketEvents).toHaveBeenCalledWith('tkt_1', { limit: 20 });
    });

    it('lets a manager read any ticket, one that has no team yet included', async () => {
      expect((await handler(event('', manager))).statusCode).toBe(200);

      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
      });
      expect((await handler(event('', manager))).statusCode).toBe(200);
    });

    it("answers 403 for another team's ticket and for one with no team", async () => {
      expect((await handler(event('', otherTeam))).statusCode).toBe(403);

      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
      });
      expect((await handler(event('', technician))).statusCode).toBe(403);
      expect(listTicketEvents).not.toHaveBeenCalled();
    });

    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event());
      expect(response.statusCode).toBe(404);
      expect(listTicketEvents).not.toHaveBeenCalled();
    });

    it("refuses a reporter's LINE token with 401, like every staff endpoint", async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event('', 'reporter'));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('needs a token', async () => {
      vi.mocked(requireStaff).mockImplementation(async (authorization) =>
        staffFromAuthorization(authorization),
      );
      const response = await handler(event('', null));
      expect(response.statusCode).toBe(401);
    });
  });

  describe('paging', () => {
    it('passes limit, and hands out a cursor only when there is more', async () => {
      vi.mocked(listTicketEvents).mockResolvedValue({
        events,
        next: '2026-11-05T11:00:00.000Z#tkt_1_status_v3',
      });
      const first = body(await handler(event('limit=2')));
      expect(listTicketEvents).toHaveBeenLastCalledWith('tkt_1', { limit: 2 });
      expect(first.nextCursor).toEqual(expect.any(String));

      vi.mocked(listTicketEvents).mockResolvedValue({ events: [] });
      const last = body(
        await handler(event(`limit=2&cursor=${first.nextCursor}`)),
      );
      expect(listTicketEvents).toHaveBeenLastCalledWith('tkt_1', {
        limit: 2,
        after: '2026-11-05T11:00:00.000Z#tkt_1_status_v3',
      });
      expect(last).not.toHaveProperty('nextCursor');
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=5&limit=6',
      'status=DONE',
      'cursor=not-a-cursor',
      `cursor=${cursorOf('text')}`,
      `cursor=${cursorOf({ r: 'x' })}`,
      `cursor=${cursorOf({ e: 5 })}`,
      `cursor=${'a'.repeat(1001)}`,
    ])('answers 400 for %s', async (query) => {
      const response = await handler(event(query));
      expect(response.statusCode).toBe(400);
      expect(listTicketEvents).not.toHaveBeenCalled();
    });
  });

  it('shows no storage fields and no private data', async () => {
    vi.mocked(listTicketEvents).mockResolvedValue({
      events: [
        {
          ...events[0],
          eventKey: 'secret-key',
        } as unknown as TicketEventRecord,
      ],
    });
    const response = await handler(event());
    expect(response.body).not.toContain('eventKey');
    expect(response.body).not.toContain('secret-key');
    expect(response.body).not.toContain('Ureporter');
  });

  it('answers 400 when the ticket id is missing', async () => {
    const response = await handler(event('', technician, null));
    expect(response.statusCode).toBe(400);
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(listTicketEvents).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
