import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';
import { computeDeadline } from '../../backend/src/triage/policy';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  setTicketPriority: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/set-priority';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  getTicket,
  setTicketPriority,
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

const CREATED = '2026-11-05T08:00:00.000Z';
const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'ASSIGNED',
  repairCycle: 1,
  photos: [],
  version: 3,
  reporterLineUserId: 'Ureporter',
  teamId: 'PLUMBING',
  category: 'PLUMBING',
  priority: 'LOW',
  prioritySetBy: 'AI',
  deadlineAt: computeDeadline(CREATED, 'PLUMBING', 'LOW'),
  createdAt: CREATED,
  updatedAt: '2026-11-05T08:05:00.000Z',
};

function event(
  payload: unknown,
  options: {
    who?: StaffIdentity | null;
    rawBody?: string;
    base64?: boolean;
    ticketId?: string | null;
  } = {},
): APIGatewayProxyEventV2 {
  const { who = technician, rawBody, ticketId = 'tkt_1' } = options;
  const body = rawBody ?? JSON.stringify(payload);
  return {
    headers: who ? { authorization: `Bearer ${signStaffToken(who)}` } : {},
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: options.base64 ?? false,
    pathParameters: ticketId === null ? {} : { ticketId },
    requestContext: { requestId: 'req-1', http: { method: 'PATCH' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

function cancelled(codes: string[]) {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe('PATCH /tickets/{ticketId}/priority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(setTicketPriority).mockResolvedValue(undefined);
  });

  describe('changing the priority', () => {
    it('changes it with a reason, recounts the deadline from creation and returns the ticket', async () => {
      const response = await handler(
        event({
          priority: 'CRITICAL',
          reason: '  Water near the lift motor  ',
        }),
      );

      expect(response.statusCode).toBe(200);
      const expectedDeadline = computeDeadline(CREATED, 'PLUMBING', 'CRITICAL');
      expect(setTicketPriority).toHaveBeenCalledWith(ticket, {
        to: 'CRITICAL',
        accountId: 'plumbing@example.com',
        teamId: 'PLUMBING',
        now: expect.any(String),
        reason: 'Water near the lift motor',
        deadlineAt: expectedDeadline,
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        priority: 'CRITICAL',
        prioritySetBy: 'STAFF',
        deadlineAt: expectedDeadline,
      });
      expect(response.body).not.toContain('version');
      expect(response.body).not.toContain('Ureporter');
    });

    it('needs a reason when the priority changes', async () => {
      for (const payload of [
        { priority: 'CRITICAL' },
        { priority: 'CRITICAL', reason: '   ' },
        { priority: 'CRITICAL', reason: '' },
      ]) {
        const response = await handler(event(payload));
        expect(response.statusCode).toBe(400);
      }
      expect(setTicketPriority).not.toHaveBeenCalled();
    });

    it('counts the deadline from the earlier SLA start a merge took over', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        slaStartAt: '2026-11-05T05:00:00.000Z',
      });

      await handler(event({ priority: 'MEDIUM', reason: 'More urgent' }));

      expect(vi.mocked(setTicketPriority).mock.calls[0][1].deadlineAt).toBe(
        computeDeadline('2026-11-05T05:00:00.000Z', 'PLUMBING', 'MEDIUM'),
      );
    });

    it('does not send a deadline that did not change', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        priority: 'MEDIUM',
        deadlineAt: computeDeadline(CREATED, 'PLUMBING', 'LOW'),
      });

      // LOW again: the stored deadline is already the LOW one.
      await handler(event({ priority: 'LOW', reason: 'Back to low' }));

      expect(vi.mocked(setTicketPriority).mock.calls[0][1]).not.toHaveProperty(
        'deadlineAt',
      );
    });
  });

  describe('accepting the priority the AI chose', () => {
    it('is allowed without a reason, and sets prioritySetBy to STAFF', async () => {
      const response = await handler(event({ priority: 'LOW' }));

      expect(response.statusCode).toBe(200);
      const change = vi.mocked(setTicketPriority).mock.calls[0][1];
      expect(change).toMatchObject({
        to: 'LOW',
        accountId: 'plumbing@example.com',
      });
      expect(change).not.toHaveProperty('reason');
      expect(change).not.toHaveProperty('deadlineAt');
      expect(body(response)).toMatchObject({
        priority: 'LOW',
        prioritySetBy: 'STAFF',
      });
    });

    it('keeps a reason when one is given', async () => {
      await handler(event({ priority: 'LOW', reason: 'Checked on site' }));
      expect(vi.mocked(setTicketPriority).mock.calls[0][1].reason).toBe(
        'Checked on site',
      );
    });

    it('recounts a stored deadline that no longer matches the policy', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        deadlineAt: '2026-12-01T00:00:00.000Z',
      });
      await handler(event({ priority: 'LOW' }));
      expect(vi.mocked(setTicketPriority).mock.calls[0][1].deadlineAt).toBe(
        computeDeadline(CREATED, 'PLUMBING', 'LOW'),
      );
    });
  });

  describe('asking again (idempotency)', () => {
    it('answers 200 and writes nothing when a person already set this priority', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        priority: 'CRITICAL',
        prioritySetBy: 'STAFF',
      });

      const response = await handler(
        event({ priority: 'CRITICAL', reason: 'Water near the lift motor' }),
      );

      expect(response.statusCode).toBe(200);
      expect(body(response)).toMatchObject({
        priority: 'CRITICAL',
        prioritySetBy: 'STAFF',
      });
      expect(setTicketPriority).not.toHaveBeenCalled();
    });

    it('still answers 200 for a ticket that was closed after a person set the priority', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'DONE',
        priority: 'CRITICAL',
        prioritySetBy: 'STAFF',
      });
      const response = await handler(event({ priority: 'CRITICAL' }));
      expect(response.statusCode).toBe(200);
      expect(setTicketPriority).not.toHaveBeenCalled();
    });

    it('answers 200 when a retry lost a race to the same change', async () => {
      vi.mocked(setTicketPriority).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(ticket)
        .mockResolvedValueOnce({
          ...ticket,
          priority: 'CRITICAL',
          prioritySetBy: 'STAFF',
          version: 4,
        });

      const response = await handler(
        event({ priority: 'CRITICAL', reason: 'Water near the lift motor' }),
      );
      expect(response.statusCode).toBe(200);
      expect(body(response).priority).toBe('CRITICAL');
    });

    it('answers 409 when the ticket changed some other way, or was closed', async () => {
      vi.mocked(setTicketPriority).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(ticket)
        .mockResolvedValueOnce({ ...ticket, status: 'DONE', version: 4 });

      const response = await handler(
        event({ priority: 'CRITICAL', reason: 'Water near the lift motor' }),
      );
      expect(response.statusCode).toBe(409);
    });
  });

  describe('who may do it', () => {
    it('lets a manager change a ticket of any team, recording no team', async () => {
      const response = await handler(
        event(
          { priority: 'CRITICAL', reason: 'Raised by the manager' },
          { who: manager },
        ),
      );

      expect(response.statusCode).toBe(200);
      const change = vi.mocked(setTicketPriority).mock.calls[0][1];
      expect(change.accountId).toBe('manager@example.com');
      expect(change).not.toHaveProperty('teamId');
    });

    it('answers 403 to a technician of another team, before any write', async () => {
      const response = await handler(
        event({ priority: 'CRITICAL', reason: 'x' }, { who: otherTeam }),
      );
      expect(response.statusCode).toBe(403);
      expect(setTicketPriority).not.toHaveBeenCalled();
    });

    it('answers 403 to a technician for a ticket that has no team yet', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
      });
      const response = await handler(event({ priority: 'LOW' }));
      expect(response.statusCode).toBe(403);
    });

    it('answers 401 for a token that is not a current staff token, such as a reporter', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event({ priority: 'LOW' }));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('needs a token', async () => {
      const response = await handler(event({ priority: 'LOW' }, { who: null }));
      expect(response.statusCode).toBe(401);
    });

    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event({ priority: 'LOW' }));
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the status of the ticket', () => {
    it.each(['ASSIGNED', 'IN_PROGRESS'] as const)(
      'allows %s',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({ ...ticket, status });
        const response = await handler(event({ priority: 'LOW' }));
        expect(response.statusCode).toBe(200);
      },
    );

    it.each(['DONE', 'MERGED'] as const)(
      'answers 409 for %s',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({ ...ticket, status });
        const response = await handler(
          event({ priority: 'CRITICAL', reason: 'x' }),
        );
        expect(response.statusCode).toBe(409);
        expect(setTicketPriority).not.toHaveBeenCalled();
      },
    );

    it('answers 409 for a RECEIVED ticket, which no team owns yet (a manager too)', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
        priority: undefined,
        prioritySetBy: undefined,
      });
      const response = await handler(
        event({ priority: 'LOW', reason: 'x' }, { who: manager }),
      );
      expect(response.statusCode).toBe(409);
    });
  });

  describe('a bad request body', () => {
    it.each([
      ['not JSON', { rawBody: 'nope' }],
      ['a JSON array', { rawBody: '[]' }],
      [
        'an unknown field',
        { rawBody: JSON.stringify({ priority: 'LOW', status: 'DONE' }) },
      ],
      ['a missing priority', { rawBody: JSON.stringify({ reason: 'x' }) }],
      [
        'HIGH, the name the requirements document uses',
        { rawBody: JSON.stringify({ priority: 'HIGH', reason: 'x' }) },
      ],
      [
        'a lower case priority',
        { rawBody: JSON.stringify({ priority: 'low' }) },
      ],
      [
        'a reason that is not text',
        { rawBody: JSON.stringify({ priority: 'LOW', reason: 5 }) },
      ],
      [
        'a reason over 1000 characters',
        {
          rawBody: JSON.stringify({
            priority: 'LOW',
            reason: 'a'.repeat(1001),
          }),
        },
      ],
    ])(
      'answers 400 for %s, before reading the ticket',
      async (_label, options) => {
        const response = await handler(event(undefined, options));
        expect(response.statusCode).toBe(400);
        expect(getTicket).not.toHaveBeenCalled();
      },
    );

    it('accepts a reason of exactly 1000 characters and a base64 body', async () => {
      const long = await handler(
        event({ priority: 'MEDIUM', reason: 'a'.repeat(1000) }),
      );
      expect(long.statusCode).toBe(200);

      const encoded = await handler(
        event({ priority: 'MEDIUM', reason: 'x' }, { base64: true }),
      );
      expect(encoded.statusCode).toBe(200);
    });

    it('answers 400 when the ticket id is missing', async () => {
      const response = await handler(
        event({ priority: 'LOW' }, { ticketId: null }),
      );
      expect(response.statusCode).toBe(400);
    });
  });

  it('answers 500 without details when the write fails', async () => {
    vi.mocked(setTicketPriority).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(
      event({ priority: 'CRITICAL', reason: 'x' }),
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
