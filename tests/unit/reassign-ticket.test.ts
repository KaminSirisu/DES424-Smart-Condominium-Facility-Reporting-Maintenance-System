import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  reassignTicket: vi.fn(),
}));
vi.mock('../../backend/src/triage/policy', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../backend/src/triage/policy')>();
  return { ...original, computeDeadline: vi.fn(original.computeDeadline) };
});

import { handler } from '../../backend/src/tickets/reassign-ticket';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  getTicket,
  reassignTicket,
} from '../../backend/src/shared/ticket-repository';
import { computeDeadline } from '../../backend/src/triage/policy';
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

const CREATED = '2026-11-05T08:00:00.000Z';
// The real policy, kept to restore after vi.resetAllMocks and to build the fixture.
const realComputeDeadline = vi
  .mocked(computeDeadline)
  .getMockImplementation() as (
  ...args: Parameters<typeof computeDeadline>
) => string;
const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'The air conditioner drips.',
  status: 'ASSIGNED',
  repairCycle: 1,
  photos: [],
  version: 3,
  reporterLineUserId: 'Ureporter',
  teamId: 'PLUMBING',
  category: 'PLUMBING',
  priority: 'MEDIUM',
  prioritySetBy: 'AI',
  deadlineAt: realComputeDeadline(CREATED, 'PLUMBING', 'MEDIUM'),
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
  const { who = manager, rawBody, ticketId = 'tkt_1' } = options;
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

const move = { teamId: 'HVAC', reason: '  It is the air conditioner  ' };

describe('PATCH /tickets/{ticketId}/assignment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(reassignTicket).mockResolvedValue(undefined);
    vi.mocked(computeDeadline).mockImplementation(realComputeDeadline);
  });

  describe('moving a ticket', () => {
    it('moves an ASSIGNED ticket to the other team and returns it', async () => {
      const response = await handler(event(move));

      expect(response.statusCode).toBe(200);
      expect(reassignTicket).toHaveBeenCalledWith(ticket, {
        toTeamId: 'HVAC',
        accountId: 'manager@example.com',
        now: expect.any(String),
        reason: 'It is the air conditioner',
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        teamId: 'HVAC',
        status: 'ASSIGNED',
        category: 'PLUMBING',
      });
      expect(response.body).not.toContain('version');
      expect(response.body).not.toContain('Ureporter');
    });

    it("counts the deadline again with the new team's policy, from the SLA start (SLA-08)", async () => {
      vi.mocked(computeDeadline).mockReturnValue('2026-11-05T16:00:00.000Z');
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        slaStartAt: '2026-11-05T05:00:00.000Z',
      });

      const response = await handler(event(move));

      expect(computeDeadline).toHaveBeenCalledWith(
        '2026-11-05T05:00:00.000Z',
        'HVAC',
        'MEDIUM',
      );
      expect(vi.mocked(reassignTicket).mock.calls[0][1].deadlineAt).toBe(
        '2026-11-05T16:00:00.000Z',
      );
      expect(body(response).deadlineAt).toBe('2026-11-05T16:00:00.000Z');
    });

    it('starts the count at creation when no earlier start was kept', async () => {
      await handler(event(move));
      expect(computeDeadline).toHaveBeenCalledWith(CREATED, 'HVAC', 'MEDIUM');
    });

    it('sends no deadline when the new team has the same one, or the ticket has no priority', async () => {
      await handler(event(move));
      expect(vi.mocked(reassignTicket).mock.calls[0][1]).not.toHaveProperty(
        'deadlineAt',
      );

      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        priority: undefined,
      });
      await handler(event(move));
      expect(computeDeadline).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reassignTicket).mock.calls[1][1]).not.toHaveProperty(
        'deadlineAt',
      );
    });

    it('accepts a base64 body and a reason of exactly 1000 characters', async () => {
      const encoded = await handler(event(move, { base64: true }));
      expect(encoded.statusCode).toBe(200);

      const long = await handler(
        event({ teamId: 'ELECTRICAL', reason: 'a'.repeat(1000) }),
      );
      expect(long.statusCode).toBe(200);
    });
  });

  describe('who may do it', () => {
    it('refuses a technician, even of the ticket team, with 403', async () => {
      const response = await handler(event(move, { who: technician }));
      expect(response.statusCode).toBe(403);
      expect(reassignTicket).not.toHaveBeenCalled();
    });

    it('refuses a token that is not a current staff token with 401', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event(move));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('needs a token', async () => {
      const response = await handler(event(move, { who: null }));
      expect(response.statusCode).toBe(401);
    });

    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event(move));
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the status of the ticket', () => {
    it.each(['RECEIVED', 'IN_PROGRESS', 'DONE', 'MERGED'] as const)(
      'answers 409 for %s',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({
          ...ticket,
          status,
          ...(status === 'RECEIVED' ? { teamId: undefined } : {}),
        });
        const response = await handler(event(move));
        expect(response.statusCode).toBe(409);
        expect(reassignTicket).not.toHaveBeenCalled();
      },
    );
  });

  describe('the team', () => {
    it('answers 422 for a team that does not exist', async () => {
      for (const teamId of ['NOPE', 'plumbing', 'UNASSIGNED']) {
        const response = await handler(event({ teamId, reason: 'x' }));
        expect(response.statusCode).toBe(422);
      }
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('answers 200 and writes nothing when the ticket is already with that team', async () => {
      const response = await handler(
        event({ teamId: 'PLUMBING', reason: 'again' }),
      );
      expect(response.statusCode).toBe(200);
      expect(body(response).teamId).toBe('PLUMBING');
      expect(reassignTicket).not.toHaveBeenCalled();
    });

    it('still answers 200 for that team when the work has started since', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'IN_PROGRESS',
        teamId: 'HVAC',
      });
      const response = await handler(event(move));
      expect(response.statusCode).toBe(200);
      expect(reassignTicket).not.toHaveBeenCalled();
    });

    it('answers 200 when a retry lost a race to the same move', async () => {
      vi.mocked(reassignTicket).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(ticket)
        .mockResolvedValueOnce({ ...ticket, teamId: 'HVAC', version: 4 });

      const response = await handler(event(move));
      expect(response.statusCode).toBe(200);
      expect(body(response).teamId).toBe('HVAC');
    });

    it('answers 409 when the work started or the ticket moved elsewhere meanwhile', async () => {
      vi.mocked(reassignTicket).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(ticket)
        .mockResolvedValueOnce({
          ...ticket,
          status: 'IN_PROGRESS',
          version: 4,
        });

      const response = await handler(event(move));
      expect(response.statusCode).toBe(409);
    });
  });

  describe('a bad request body', () => {
    it.each([
      ['not JSON', { rawBody: 'nope' }],
      ['a JSON array', { rawBody: '[]' }],
      [
        'an unknown field',
        { rawBody: JSON.stringify({ ...move, status: 'DONE' }) },
      ],
      ['a missing teamId', { rawBody: JSON.stringify({ reason: 'x' }) }],
      [
        'an empty teamId',
        { rawBody: JSON.stringify({ teamId: '', reason: 'x' }) },
      ],
      [
        'a teamId that is not text',
        { rawBody: JSON.stringify({ teamId: 5, reason: 'x' }) },
      ],
      ['a missing reason', { rawBody: JSON.stringify({ teamId: 'HVAC' }) }],
      [
        'an empty reason',
        { rawBody: JSON.stringify({ teamId: 'HVAC', reason: '' }) },
      ],
      [
        'a blank reason',
        { rawBody: JSON.stringify({ teamId: 'HVAC', reason: '   ' }) },
      ],
      [
        'a reason over 1000 characters',
        {
          rawBody: JSON.stringify({ teamId: 'HVAC', reason: 'a'.repeat(1001) }),
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

    it('answers 400 when the ticket id is missing', async () => {
      const response = await handler(event(move, { ticketId: null }));
      expect(response.statusCode).toBe(400);
    });
  });

  it('answers 500 without details when the write fails', async () => {
    vi.mocked(reassignTicket).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event(move));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
