import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';
import { computeDeadline } from '../../backend/src/triage/policy';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  applyTriage: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/triage-ticket';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  applyTriage,
  getTicket,
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

const CREATED = '2026-11-05T08:00:00.000Z';
const received: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Something is wrong with the lift and the lights.',
  status: 'RECEIVED',
  repairCycle: 1,
  photos: [],
  version: 1,
  reporterLineUserId: 'Ureporter',
  createdAt: CREATED,
  updatedAt: CREATED,
};

function manualTriage(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    ...received,
    status: 'ASSIGNED',
    version: 2,
    category: 'ELECTRICAL',
    teamId: 'ELECTRICAL',
    priority: 'CRITICAL',
    prioritySetBy: 'STAFF',
    deadlineAt: computeDeadline(CREATED, 'ELECTRICAL', 'CRITICAL'),
    ...overrides,
  };
}

function event(
  payload: unknown,
  options: {
    who?: StaffIdentity | null;
    rawBody?: string;
    ticketId?: string | null;
  } = {},
): APIGatewayProxyEventV2 {
  const { who = manager, rawBody, ticketId = 'tkt_1' } = options;
  return {
    headers: who ? { authorization: `Bearer ${signStaffToken(who)}` } : {},
    body: rawBody ?? JSON.stringify(payload),
    isBase64Encoded: false,
    pathParameters: ticketId === null ? {} : { ticketId },
    requestContext: { requestId: 'req-1', http: { method: 'PATCH' } },
  } as unknown as APIGatewayProxyEventV2;
}

const body = (r: { body?: string }) => JSON.parse(r.body ?? '');
const good = { teamId: 'ELECTRICAL', priority: 'CRITICAL' };

function cancelled(codes: string[]) {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe('PATCH /tickets/{ticketId}/triage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(getTicket).mockResolvedValue(received);
    vi.mocked(applyTriage).mockResolvedValue(undefined);
  });

  describe('a manager triaging a ticket the automatic triage could not classify', () => {
    it('assigns the team and priority, counts the deadline from creation and returns the ticket', async () => {
      const response = await handler(
        event({ ...good, reason: 'Lift and lights' }),
      );

      expect(response.statusCode).toBe(200);
      expect(applyTriage).toHaveBeenCalledOnce();
      expect(applyTriage).toHaveBeenCalledWith('tkt_1', 1, {
        category: 'ELECTRICAL',
        priority: 'CRITICAL',
        teamId: 'ELECTRICAL',
        // 3 hours from creation: slow triage uses up SLA time (SLA-06)
        deadlineAt: '2026-11-05T11:00:00.000Z',
        slaPolicyVersion: 2,
        staff: {
          accountId: 'manager@example.com',
          reason: 'Lift and lights',
        },
        now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        status: 'ASSIGNED',
        category: 'ELECTRICAL',
        teamId: 'ELECTRICAL',
        priority: 'CRITICAL',
        prioritySetBy: 'STAFF',
        deadlineAt: '2026-11-05T11:00:00.000Z',
      });
    });

    it.each([
      ['CRITICAL', '2026-11-05T11:00:00.000Z'],
      ['MEDIUM', '2026-11-05T20:00:00.000Z'],
      ['LOW', '2026-11-07T08:00:00.000Z'],
    ])('counts the %s deadline as %s', async (priority, deadline) => {
      const response = await handler(event({ teamId: 'HVAC', priority }));
      expect(body(response).deadlineAt).toBe(deadline);
    });

    it('is allowed to pick any of the five teams, with the category set to the team', async () => {
      for (const teamId of [
        'ELECTRICAL',
        'PLUMBING',
        'HVAC',
        'CLEANING_SANITATION',
        'BUILDING_EQUIPMENT',
      ]) {
        vi.mocked(applyTriage).mockClear();
        const response = await handler(event({ teamId, priority: 'MEDIUM' }));
        expect(response.statusCode).toBe(200);
        expect(vi.mocked(applyTriage).mock.calls[0][2]).toMatchObject({
          category: teamId,
          teamId,
        });
      }
    });

    it('trims the reason and leaves it out when it is empty or missing', async () => {
      await handler(event({ ...good, reason: '  Both lift and lights  ' }));
      expect(vi.mocked(applyTriage).mock.calls[0][2].staff).toEqual({
        accountId: 'manager@example.com',
        reason: 'Both lift and lights',
      });
      await handler(event({ ...good, reason: '   ' }));
      expect(vi.mocked(applyTriage).mock.calls[1][2].staff).toEqual({
        accountId: 'manager@example.com',
      });
      await handler(event(good));
      expect(vi.mocked(applyTriage).mock.calls[2][2].staff).toEqual({
        accountId: 'manager@example.com',
      });
    });

    it('never returns an internal field', async () => {
      const response = await handler(event(good));
      for (const field of ['reporterLineUserId', 'version', 'safetyHazard']) {
        expect(body(response)).not.toHaveProperty(field);
      }
      expect(response.body).not.toContain('Ureporter');
    });
  });

  describe('who may triage', () => {
    it('refuses a technician with 403 and reads nothing', async () => {
      const response = await handler(event(good, { who: technician }));
      expect(response.statusCode).toBe(403);
      expect(body(response).error.code).toBe('FORBIDDEN');
      expect(getTicket).not.toHaveBeenCalled();
      expect(applyTriage).not.toHaveBeenCalled();
    });

    it('passes on a 401 from the token check', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'no'),
      );
      const response = await handler(event(good, { who: null }));
      expect(response.statusCode).toBe(401);
      expect(applyTriage).not.toHaveBeenCalled();
    });
  });

  describe('a bad request', () => {
    it.each([
      ['no teamId', { priority: 'MEDIUM' }],
      ['an unknown team', { teamId: 'GARDEN', priority: 'MEDIUM' }],
      ['a team that is not text', { teamId: 5, priority: 'MEDIUM' }],
      ['no priority', { teamId: 'HVAC' }],
      ['an unknown priority', { teamId: 'HVAC', priority: 'HIGH' }],
      ['a reason that is not text', { ...good, reason: 5 }],
      ['a reason that is too long', { ...good, reason: 'x'.repeat(1001) }],
      ['an unknown field', { ...good, status: 'ASSIGNED' }],
    ])(
      'answers 400 for %s, without reading or writing',
      async (_n, payload) => {
        const response = await handler(event(payload));
        expect(response.statusCode).toBe(400);
        expect(getTicket).not.toHaveBeenCalled();
        expect(applyTriage).not.toHaveBeenCalled();
      },
    );

    it('takes a reason of exactly 1000 characters', async () => {
      const response = await handler(
        event({ ...good, reason: 'x'.repeat(1000) }),
      );
      expect(response.statusCode).toBe(200);
    });

    it('answers 400 for a body that is not JSON, not an object, or missing, and for a missing ticket id', async () => {
      expect(
        (await handler(event(undefined, { rawBody: '{nope' }))).statusCode,
      ).toBe(400);
      expect((await handler(event([]))).statusCode).toBe(400);
      expect((await handler(event(good, { ticketId: null }))).statusCode).toBe(
        400,
      );
      expect(applyTriage).not.toHaveBeenCalled();
    });

    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event(good));
      expect(response.statusCode).toBe(404);
      expect(applyTriage).not.toHaveBeenCalled();
    });
  });

  describe('a ticket that is not waiting for triage', () => {
    it.each(['ASSIGNED', 'IN_PROGRESS', 'DONE', 'MERGED'] as const)(
      'answers 409 for a %s ticket and writes nothing',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({
          ...received,
          status,
          teamId: 'PLUMBING',
          priority: 'MEDIUM',
          prioritySetBy: 'AI',
        });
        const response = await handler(event(good));
        expect(response.statusCode).toBe(409);
        expect(body(response).error.code).toBe('INVALID_TRANSITION');
        expect(applyTriage).not.toHaveBeenCalled();
      },
    );

    it('answers 200 with the ticket as it is when a manager already triaged it exactly so', async () => {
      vi.mocked(getTicket).mockResolvedValue(manualTriage());
      const response = await handler(event(good));
      expect(response.statusCode).toBe(200);
      expect(body(response)).toMatchObject({
        status: 'ASSIGNED',
        teamId: 'ELECTRICAL',
        prioritySetBy: 'STAFF',
      });
      expect(applyTriage).not.toHaveBeenCalled();
    });

    it('answers 409, not a replay, once work on a manually triaged ticket has started', async () => {
      vi.mocked(getTicket).mockResolvedValue(
        manualTriage({ status: 'IN_PROGRESS' }),
      );
      const response = await handler(event(good));
      expect(response.statusCode).toBe(409);
      expect(body(response).error.code).toBe('INVALID_TRANSITION');
      expect(applyTriage).not.toHaveBeenCalled();
    });

    it('answers 409 when it was triaged with another team, another priority, or by the AI', async () => {
      for (const current of [
        manualTriage({ teamId: 'PLUMBING', category: 'PLUMBING' }),
        manualTriage({ priority: 'LOW' }),
        manualTriage({ prioritySetBy: 'AI' }),
      ]) {
        vi.mocked(getTicket).mockResolvedValue(current);
        expect((await handler(event(good))).statusCode).toBe(409);
      }
      expect(applyTriage).not.toHaveBeenCalled();
    });
  });

  describe('a change while the request runs', () => {
    it('answers 200 when the ticket was just triaged exactly so by this request elsewhere', async () => {
      vi.mocked(applyTriage).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(received)
        .mockResolvedValueOnce(manualTriage());

      const response = await handler(event(good));

      expect(response.statusCode).toBe(200);
      expect(body(response).prioritySetBy).toBe('STAFF');
    });

    it('answers 409 when the automatic triage or another manager won with something else', async () => {
      vi.mocked(applyTriage).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(received)
        .mockResolvedValueOnce(
          manualTriage({ prioritySetBy: 'AI', teamId: 'PLUMBING' }),
        );
      const response = await handler(event(good));
      expect(response.statusCode).toBe(409);
      expect(body(response).error.code).toBe('CONFLICT');
    });

    it('answers 409 when the ticket cannot be read again', async () => {
      vi.mocked(applyTriage).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(received)
        .mockResolvedValueOnce(null);
      expect((await handler(event(good))).statusCode).toBe(409);
    });

    it('answers 500 without details for any other failure', async () => {
      vi.mocked(applyTriage).mockRejectedValue(new Error('table gone: secret'));
      const response = await handler(event(good));
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret');

      vi.mocked(applyTriage).mockRejectedValue(
        cancelled(['None', 'ValidationError']),
      );
      expect((await handler(event(good))).statusCode).toBe(500);
    });
  });
});
