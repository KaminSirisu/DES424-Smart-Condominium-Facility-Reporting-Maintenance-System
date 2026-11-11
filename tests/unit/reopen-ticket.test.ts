import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';
import { computeDeadline } from '../../backend/src/triage/policy';

vi.mock('../../backend/src/shared/line-token', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/line-token')
  >()),
  verifyLineToken: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  isReporterOf: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  reopenTicket: vi.fn(),
}));

import {
  REOPEN_WINDOW_DAYS,
  handler,
  reopenKeyHash,
} from '../../backend/src/tickets/reopen-ticket';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { isReporterOf } from '../../backend/src/shared/ticket-reporters';
import {
  getTicket,
  reopenTicket,
} from '../../backend/src/shared/ticket-repository';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DAY = 24 * 60 * 60 * 1000;
const KEY = 'reopen-attempt-1';
const HASH = reopenKeyHash('tkt_1', 'Ureporter', KEY);

const done: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'DONE',
  repairCycle: 1,
  photos: [
    {
      id: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-11-05T08:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Ureporter/upl_1',
    },
  ],
  version: 6,
  reporterLineUserId: 'Ureporter',
  teamId: 'PLUMBING',
  category: 'PLUMBING',
  priority: 'MEDIUM',
  prioritySetBy: 'AI',
  deadlineAt: '2026-11-05T20:00:00.000Z',
  completedAt: '2026-11-05T15:00:00.000Z',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T15:00:00.000Z',
};

function event(
  payload?: unknown,
  options: {
    token?: string | null;
    key?: string | null;
    rawBody?: string;
    base64?: boolean;
    ticketId?: string | null;
  } = {},
): APIGatewayProxyEventV2 {
  const { token = 'line.id.token', key = KEY, rawBody } = options;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers['idempotency-key'] = key;
  const body =
    rawBody ?? (payload === undefined ? undefined : JSON.stringify(payload));
  return {
    headers,
    body:
      body !== undefined && options.base64
        ? Buffer.from(body).toString('base64')
        : body,
    isBase64Encoded: options.base64 ?? false,
    pathParameters:
      options.ticketId === null
        ? {}
        : { ticketId: options.ticketId ?? 'tkt_1' },
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
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

describe('POST /tickets/{ticketId}/reopen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(verifyLineToken).mockResolvedValue('Ureporter');
    vi.mocked(isReporterOf).mockResolvedValue(true);
    vi.mocked(getTicket).mockResolvedValue(done);
    vi.mocked(reopenTicket).mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  describe('reopening a finished repair', () => {
    it('sends it back to the team with a new SLA clock from now and the same priority', async () => {
      const response = await handler(
        event({ reason: '  The faucet leaks again ' }),
      );

      expect(response.statusCode).toBe(200);
      const deadline = computeDeadline(NOW_ISO, 'PLUMBING', 'MEDIUM');
      expect(reopenTicket).toHaveBeenCalledWith(done, {
        now: NOW_ISO,
        reopenKey: HASH,
        reason: 'The faucet leaks again',
        deadlineAt: deadline,
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        status: 'ASSIGNED',
        repairCycle: 2,
        priority: 'MEDIUM',
        deadlineAt: deadline,
        createdAt: '2026-11-05T08:00:00.000Z',
        updatedAt: NOW_ISO,
      });
      expect(body(response)).not.toHaveProperty('completedAt');
    });

    it('shows no internal field and no LINE id', async () => {
      const response = await handler(event());
      for (const hidden of [
        'reopenKey',
        'slaStartAt',
        'version',
        'Ureporter',
      ]) {
        expect(response.body).not.toContain(hidden);
      }
      expect(response.body).not.toContain(HASH);
    });

    it('works without a body, with an empty body and with a base64 body', async () => {
      expect((await handler(event())).statusCode).toBe(200);
      expect(
        (await handler(event(undefined, { rawBody: '' }))).statusCode,
      ).toBe(200);
      expect(
        (await handler(event({ reason: 'x' }, { base64: true }))).statusCode,
      ).toBe(200);
    });

    it('leaves a blank reason out', async () => {
      await handler(event({ reason: '   ' }));
      expect(vi.mocked(reopenTicket).mock.calls[0][1]).not.toHaveProperty(
        'reason',
      );
    });

    it('sends no deadline for a ticket that has no priority', async () => {
      vi.mocked(getTicket).mockResolvedValue({ ...done, priority: undefined });
      await handler(event());
      expect(vi.mocked(reopenTicket).mock.calls[0][1]).not.toHaveProperty(
        'deadlineAt',
      );
    });

    it('uses the team and priority of the ticket for the new deadline', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...done,
        teamId: 'HVAC',
        priority: 'CRITICAL',
      });
      await handler(event());
      expect(vi.mocked(reopenTicket).mock.calls[0][1].deadlineAt).toBe(
        computeDeadline(NOW_ISO, 'HVAC', 'CRITICAL'),
      );
    });
  });

  describe('the 7 day window (RR-03)', () => {
    const completedAgo = (ms: number): TicketRecord => ({
      ...done,
      completedAt: new Date(NOW.getTime() - ms).toISOString(),
    });

    it('allows a reopen up to exactly 7 days after completion', async () => {
      vi.mocked(getTicket).mockResolvedValue(
        completedAgo(REOPEN_WINDOW_DAYS * DAY),
      );
      expect((await handler(event())).statusCode).toBe(200);
    });

    it('answers 409 and asks for a new report a moment after that', async () => {
      vi.mocked(getTicket).mockResolvedValue(
        completedAgo(REOPEN_WINDOW_DAYS * DAY + 1),
      );
      const response = await handler(event());

      expect(response.statusCode).toBe(409);
      expect(body(response).error.code).toBe('REOPEN_WINDOW_CLOSED');
      expect(body(response).error.message).toContain('new report');
      expect(reopenTicket).not.toHaveBeenCalled();
    });

    it('is 7 days', () => {
      expect(REOPEN_WINDOW_DAYS).toBe(7);
    });

    it('counts from the last update when the completion time is missing', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...done,
        completedAt: undefined,
        updatedAt: new Date(NOW.getTime() - 8 * DAY).toISOString(),
      });
      expect((await handler(event())).statusCode).toBe(409);
    });
  });

  describe('the status of the ticket', () => {
    it.each(['RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'MERGED'] as const)(
      'answers 409 for %s',
      async (status) => {
        vi.mocked(getTicket).mockResolvedValue({ ...done, status });
        const response = await handler(event());
        expect(response.statusCode).toBe(409);
        expect(reopenTicket).not.toHaveBeenCalled();
      },
    );

    it('answers 409 for a finished ticket that has no team', async () => {
      vi.mocked(getTicket).mockResolvedValue({ ...done, teamId: undefined });
      const response = await handler(event());
      expect(response.statusCode).toBe(409);
      expect(reopenTicket).not.toHaveBeenCalled();
    });
  });

  describe('asking again (idempotency)', () => {
    it('answers 200 and writes nothing for a retry of the request that reopened it', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...done,
        status: 'ASSIGNED',
        repairCycle: 2,
        reopenKey: HASH,
      });

      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(body(response)).toMatchObject({
        status: 'ASSIGNED',
        repairCycle: 2,
      });
      expect(reopenTicket).not.toHaveBeenCalled();
    });

    it('still answers 200 for a retry that comes after the second repair was finished', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...done,
        repairCycle: 2,
        reopenKey: HASH,
      });

      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(reopenTicket).not.toHaveBeenCalled();
    });

    it('treats another key on a reopened ticket as a new request, which cannot reopen it again', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...done,
        status: 'ASSIGNED',
        repairCycle: 2,
        reopenKey: HASH,
      });

      const response = await handler(
        event(undefined, { key: 'another-key-2' }),
      );

      expect(response.statusCode).toBe(409);
    });

    it('answers 200 when a retry lost a race to the same reopen', async () => {
      vi.mocked(reopenTicket).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(done)
        .mockResolvedValueOnce({
          ...done,
          status: 'ASSIGNED',
          repairCycle: 2,
          reopenKey: HASH,
        });

      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(body(response).status).toBe('ASSIGNED');
    });

    it('answers 409 when the ticket changed in some other way', async () => {
      vi.mocked(reopenTicket).mockRejectedValue(
        cancelled(['ConditionalCheckFailed', 'None']),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(done)
        .mockResolvedValueOnce({
          ...done,
          status: 'ASSIGNED',
          reopenKey: 'other',
        });

      expect((await handler(event())).statusCode).toBe(409);
    });

    it('does not keep the key itself, and ties the hash to the ticket and the reporter', () => {
      expect(HASH).not.toContain(KEY);
      expect(HASH).toMatch(/^[0-9a-f]{64}$/);
      expect(reopenKeyHash('tkt_2', 'Ureporter', KEY)).not.toBe(HASH);
      expect(reopenKeyHash('tkt_1', 'Uother', KEY)).not.toBe(HASH);
      expect(reopenKeyHash('tkt_1', 'Ureporter', KEY)).toBe(HASH);
    });
  });

  describe('who may reopen', () => {
    it('answers 404 for someone who is not a reporter of the ticket, as for reading it', async () => {
      vi.mocked(isReporterOf).mockResolvedValue(false);
      const response = await handler(event());
      expect(response.statusCode).toBe(404);
      expect(reopenTicket).not.toHaveBeenCalled();
    });

    it('answers 404 for a ticket that does not exist, without checking reporters', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event());
      expect(response.statusCode).toBe(404);
      expect(isReporterOf).not.toHaveBeenCalled();
    });

    it('needs a LINE token, and a good one', async () => {
      expect(
        (await handler(event(undefined, { token: null }))).statusCode,
      ).toBe(401);

      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      expect((await handler(event())).statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });
  });

  describe('a bad request', () => {
    it.each([
      ['no Idempotency-Key', { key: null }],
      ['a too short Idempotency-Key', { key: 'short' }],
      ['a too long Idempotency-Key', { key: 'x'.repeat(129) }],
      ['a body that is not JSON', { rawBody: 'nope' }],
      ['a JSON array', { rawBody: '[]' }],
      ['an unknown field', { rawBody: JSON.stringify({ status: 'ASSIGNED' }) }],
      ['a reason that is not text', { rawBody: JSON.stringify({ reason: 5 }) }],
      [
        'a reason over 1000 characters',
        { rawBody: JSON.stringify({ reason: 'a'.repeat(1001) }) },
      ],
      ['a missing ticket id', { ticketId: null }],
    ])(
      'answers 400 for %s, before reading the ticket',
      async (_label, options) => {
        const response = await handler(event(undefined, options));
        expect(response.statusCode).toBe(400);
        expect(getTicket).not.toHaveBeenCalled();
      },
    );

    it('accepts a reason of exactly 1000 characters', async () => {
      const response = await handler(event({ reason: 'a'.repeat(1000) }));
      expect(response.statusCode).toBe(200);
    });
  });

  it('answers 500 without details when the write fails', async () => {
    vi.mocked(reopenTicket).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
