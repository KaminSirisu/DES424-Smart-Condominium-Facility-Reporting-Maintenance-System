import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';
import { computeDeadline } from '../../backend/src/triage/policy';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  listReporterIds: vi.fn(),
}));
vi.mock(
  '../../backend/src/shared/ticket-repository',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../backend/src/shared/ticket-repository')
    >()),
    getTicket: vi.fn(),
    mergeTickets: vi.fn(),
  }),
);

import { handler, MAX_SOURCES } from '../../backend/src/tickets/merge-tickets';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import { listReporterIds } from '../../backend/src/shared/ticket-reporters';
import {
  getTicket,
  MAX_TRANSACTION_ITEMS,
  mergeTickets,
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

function event(
  payload: unknown,
  options: {
    identity?: StaffIdentity | null;
    rawBody?: string;
    key?: string | null;
    ticketId?: string;
    base64?: boolean;
  } = {},
): APIGatewayProxyEventV2 {
  const { identity = technician, rawBody, key = 'merge-attempt-1' } = options;
  const headers: Record<string, string> = {};
  if (identity) headers.authorization = `Bearer ${signStaffToken(identity)}`;
  if (key !== null) headers['idempotency-key'] = key;
  const body = rawBody ?? JSON.stringify(payload);
  return {
    headers,
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: options.base64 ?? false,
    pathParameters: { ticketId: options.ticketId ?? 'tkt_main' },
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

// MEDIUM, 24 hours from 2026-11-05T08:00Z, as triage would have set it.
const main: TicketRecord = {
  id: 'tkt_main',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'ASSIGNED',
  repairCycle: 1,
  photos: [],
  version: 4,
  reporterLineUserId: 'Uaaa',
  teamId: 'PLUMBING',
  category: 'PLUMBING',
  priority: 'MEDIUM',
  prioritySetBy: 'AI',
  deadlineAt: '2026-11-05T20:00:00.000Z',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T08:05:00.000Z',
};
const dup1: TicketRecord = {
  ...main,
  id: 'tkt_dup1',
  version: 2,
  reporterLineUserId: 'Ubbb',
  createdAt: '2026-11-05T08:30:00.000Z',
  deadlineAt: '2026-11-05T20:30:00.000Z',
};
const dup2: TicketRecord = {
  ...dup1,
  id: 'tkt_dup2',
  status: 'IN_PROGRESS',
  version: 3,
  reporterLineUserId: 'Uccc',
  createdAt: '2026-11-05T09:00:00.000Z',
  deadlineAt: '2026-11-05T21:00:00.000Z',
};

const tickets = new Map<string, TicketRecord | null>();
const reporters = new Map<string, string[]>();

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}
const merge = (ids: string[] = ['tkt_dup1']) =>
  handler(event({ sourceTicketIds: ids }));

describe('POST /tickets/{ticketId}/merge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    tickets.clear();
    tickets.set('tkt_main', main);
    tickets.set('tkt_dup1', dup1);
    tickets.set('tkt_dup2', dup2);
    reporters.clear();
    reporters.set('tkt_main', ['Uaaa']);
    reporters.set('tkt_dup1', ['Ubbb']);
    reporters.set('tkt_dup2', ['Uccc']);
    vi.mocked(getTicket).mockImplementation(
      async (id) => tickets.get(id) ?? null,
    );
    vi.mocked(listReporterIds).mockImplementation(
      async (id) => reporters.get(id) ?? [],
    );
    vi.mocked(mergeTickets).mockResolvedValue(undefined);
  });

  describe('a merge', () => {
    it('merges the sources into the ticket and returns it without private fields', async () => {
      const response = await merge(['tkt_dup1', 'tkt_dup2']);

      expect(response.statusCode).toBe(200);
      expect(mergeTickets).toHaveBeenCalledWith(main, [dup1, dup2], {
        accountId: 'plumbing@example.com',
        teamId: 'PLUMBING',
        now: expect.any(String),
        reporters: [
          { lineUserId: 'Ubbb', sourceTicketId: 'tkt_dup1' },
          { lineUserId: 'Uccc', sourceTicketId: 'tkt_dup2' },
        ],
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_main',
        status: 'ASSIGNED',
        priority: 'MEDIUM',
        createdAt: '2026-11-05T08:00:00.000Z',
      });
      expect(response.body).not.toContain('reporterLineUserId');
      expect(response.body).not.toContain('Ubbb');
    });

    it('does not link a reporter the ticket already has, and links each reporter once', async () => {
      reporters.set('tkt_dup1', ['Ubbb', 'Uaaa']);
      reporters.set('tkt_dup2', ['Ubbb', 'Uccc']);

      await merge(['tkt_dup1', 'tkt_dup2']);

      expect(vi.mocked(mergeTickets).mock.calls[0][2].reporters).toEqual([
        { lineUserId: 'Ubbb', sourceTicketId: 'tkt_dup1' },
        { lineUserId: 'Uccc', sourceTicketId: 'tkt_dup2' },
      ]);
    });

    it('carries over every reporter of a source that had merged others before', async () => {
      reporters.set('tkt_dup1', ['Ubbb', 'Ueee', 'Ufff']);

      await merge();

      expect(
        vi
          .mocked(mergeTickets)
          .mock.calls[0][2].reporters.map((r) => r.lineUserId),
      ).toEqual(['Ubbb', 'Ueee', 'Ufff']);
    });

    it('lets the ticket take the highest priority and a deadline counted from the earliest creation (SLA-09)', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        priority: 'CRITICAL',
        createdAt: '2026-11-05T07:00:00.000Z',
      });

      const response = await merge();

      const change = vi.mocked(mergeTickets).mock.calls[0][2];
      expect(change.priority).toBe('CRITICAL');
      // 3 hours after the earliest creation time, 07:00.
      expect(change.deadlineAt).toBe('2026-11-05T10:00:00.000Z');
      // createdAt stays; the earlier start is kept apart for later recounts.
      expect(change.slaStartAt).toBe('2026-11-05T07:00:00.000Z');
      expect(body(response)).toMatchObject({
        priority: 'CRITICAL',
        deadlineAt: '2026-11-05T10:00:00.000Z',
        createdAt: '2026-11-05T08:00:00.000Z',
      });
      expect(body(response)).not.toHaveProperty('slaStartAt');
    });

    it('moves only the deadline when an older ticket has the same priority', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        createdAt: '2026-11-05T06:00:00.000Z',
      });

      await merge();

      const change = vi.mocked(mergeTickets).mock.calls[0][2];
      expect(change).not.toHaveProperty('priority');
      // 12 hours (MEDIUM) after the earliest creation time, 06:00.
      expect(change.deadlineAt).toBe('2026-11-05T18:00:00.000Z');
      expect(change.slaStartAt).toBe('2026-11-05T06:00:00.000Z');
    });

    it('counts from an earlier SLA start that a source took over in a merge of its own', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        slaStartAt: '2026-11-05T05:00:00.000Z',
      });

      await merge();

      const change = vi.mocked(mergeTickets).mock.calls[0][2];
      expect(change.slaStartAt).toBe('2026-11-05T05:00:00.000Z');
      expect(change.deadlineAt).toBe(
        computeDeadline('2026-11-05T05:00:00.000Z', 'PLUMBING', 'MEDIUM'),
      );
    });

    it('keeps the SLA start the canonical ticket already has when it is the earliest', async () => {
      tickets.set('tkt_main', {
        ...main,
        slaStartAt: '2026-11-05T04:00:00.000Z',
      });

      await merge();

      const change = vi.mocked(mergeTickets).mock.calls[0][2];
      expect(change).not.toHaveProperty('slaStartAt');
      expect(change.deadlineAt).toBe(
        computeDeadline('2026-11-05T04:00:00.000Z', 'PLUMBING', 'MEDIUM'),
      );
    });

    it('never lowers the priority or pushes the deadline later', async () => {
      tickets.set('tkt_dup1', { ...dup1, priority: 'LOW' });

      await merge();

      const change = vi.mocked(mergeTickets).mock.calls[0][2];
      expect(change).not.toHaveProperty('priority');
      expect(change).not.toHaveProperty('deadlineAt');
      expect(change).not.toHaveProperty('slaStartAt');
    });

    it('accepts an IN_PROGRESS ticket as the canonical ticket', async () => {
      tickets.set('tkt_main', { ...main, status: 'IN_PROGRESS' });

      expect((await merge()).statusCode).toBe(200);
    });

    it('does not check that the locations match (the technician decides)', async () => {
      tickets.set('tkt_dup1', { ...dup1, location: 'Pool, far side' });

      expect((await merge()).statusCode).toBe(200);
    });

    it('accepts a base64 encoded body', async () => {
      const response = await handler(
        event({ sourceTicketIds: ['tkt_dup1'] }, { base64: true }),
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe('retries', () => {
    it('answers 200 and writes nothing when every source already is merged into the ticket', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        status: 'MERGED',
        mergedIntoTicketId: 'tkt_main',
      });

      const response = await merge();

      expect(response.statusCode).toBe(200);
      expect(body(response).id).toBe('tkt_main');
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('merges only the sources that are still open', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        status: 'MERGED',
        mergedIntoTicketId: 'tkt_main',
      });

      await merge(['tkt_dup1', 'tkt_dup2']);

      expect(vi.mocked(mergeTickets).mock.calls[0][1]).toEqual([dup2]);
    });

    it('answers 200 when a parallel request merged the same sources first', async () => {
      vi.mocked(mergeTickets).mockRejectedValue(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
      vi.mocked(getTicket)
        .mockResolvedValueOnce(main)
        .mockResolvedValueOnce(dup1)
        .mockResolvedValueOnce(main)
        .mockResolvedValueOnce({
          ...dup1,
          status: 'MERGED',
          mergedIntoTicketId: 'tkt_main',
        });

      expect((await merge()).statusCode).toBe(200);
    });

    it('answers 409 when a ticket changed during the merge', async () => {
      vi.mocked(mergeTickets).mockRejectedValue(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );

      const response = await merge();

      expect(response.statusCode).toBe(409);
      expect(body(response).error.code).toBe('CONFLICT');
    });

    it('answers 500, without detail, for any other failure', async () => {
      vi.mocked(mergeTickets).mockRejectedValue(new Error('throttled'));

      const response = await merge();

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('throttled');
    });
  });

  describe('who may merge, and what', () => {
    it('answers 403 to a manager, before reading any ticket', async () => {
      const response = await handler(
        event(
          { sourceTicketIds: ['tkt_dup1'] },
          {
            identity: {
              accountId: 'm@example.com',
              role: 'MANAGER',
              tokenVersion: 0,
            },
          },
        ),
      );

      expect(response.statusCode).toBe(403);
      expect(body(response).error.code).toBe('FORBIDDEN');
      expect(getTicket).not.toHaveBeenCalled();
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('answers 403 to a technician of another team for the canonical ticket', async () => {
      const response = await handler(
        event(
          { sourceTicketIds: ['tkt_dup1'] },
          { identity: { ...technician, teamId: 'ELECTRICAL' } },
        ),
      );

      expect(response.statusCode).toBe(403);
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('answers 403 when a source belongs to another team', async () => {
      tickets.set('tkt_dup2', { ...dup2, teamId: 'ELECTRICAL' });

      const response = await merge(['tkt_dup1', 'tkt_dup2']);

      expect(response.statusCode).toBe(403);
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('answers 403 when a source has no team yet (RECEIVED)', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        status: 'RECEIVED',
        teamId: undefined,
      });

      expect((await merge()).statusCode).toBe(403);
    });

    it.each(['DONE', 'MERGED', 'RECEIVED'] as const)(
      'answers 409 when the ticket is %s',
      async (status) => {
        tickets.set('tkt_main', { ...main, status });

        const response = await merge();

        expect(response.statusCode).toBe(409);
        expect(body(response).error.code).toBe('INVALID_TRANSITION');
        expect(mergeTickets).not.toHaveBeenCalled();
      },
    );

    it('answers 409 when a source is already closed', async () => {
      tickets.set('tkt_dup2', { ...dup2, status: 'DONE' });

      const response = await merge(['tkt_dup1', 'tkt_dup2']);

      expect(response.statusCode).toBe(409);
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('answers 409 when a source is merged into a different ticket', async () => {
      tickets.set('tkt_dup1', {
        ...dup1,
        status: 'MERGED',
        mergedIntoTicketId: 'tkt_other',
      });

      expect((await merge()).statusCode).toBe(409);
    });

    it('answers 404 for an unknown ticket', async () => {
      tickets.set('tkt_main', null);
      expect((await merge()).statusCode).toBe(404);
    });

    it('answers 422 for an unknown source', async () => {
      const response = await merge(['tkt_dup1', 'tkt_missing']);

      expect(response.statusCode).toBe(422);
      expect(mergeTickets).not.toHaveBeenCalled();
    });

    it('answers 422 for a ticket merged into itself', async () => {
      expect((await merge(['tkt_main'])).statusCode).toBe(422);
    });

    it('answers 422 when there are more than the allowed number of sources', async () => {
      const ids = Array.from(
        { length: MAX_SOURCES + 1 },
        (_, i) => `tkt_x${i}`,
      );

      const response = await merge(ids);

      expect(response.statusCode).toBe(422);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('accepts the largest number of sources', async () => {
      const ids = Array.from({ length: MAX_SOURCES }, (_, i) => `tkt_x${i}`);
      for (const id of ids) {
        tickets.set(id, { ...dup1, id });
        reporters.set(id, [`U${id}`]);
      }

      expect((await merge(ids)).statusCode).toBe(200);
      expect(vi.mocked(mergeTickets).mock.calls[0][1]).toHaveLength(
        MAX_SOURCES,
      );
    });

    it('answers 422 when the reporters would not fit in one transaction', async () => {
      reporters.set(
        'tkt_dup1',
        Array.from({ length: MAX_TRANSACTION_ITEMS }, (_, i) => `U${i}`),
      );

      const response = await merge();

      expect(response.statusCode).toBe(422);
      expect(mergeTickets).not.toHaveBeenCalled();
    });
  });

  describe('the request', () => {
    it.each([
      ['invalid JSON', undefined, '{nope'],
      ['an array', [], undefined],
      ['an unknown field', { sourceTicketIds: ['tkt_dup1'], x: 1 }, undefined],
      ['no sources', {}, undefined],
      ['an empty list', { sourceTicketIds: [] }, undefined],
      ['a list that is not strings', { sourceTicketIds: [1] }, undefined],
      ['an empty id', { sourceTicketIds: [''] }, undefined],
      [
        'a repeated source',
        { sourceTicketIds: ['tkt_dup1', 'tkt_dup1'] },
        undefined,
      ],
      [
        'an id that is too long',
        { sourceTicketIds: ['t'.repeat(129)] },
        undefined,
      ],
    ])('answers 400 for %s', async (_label, payload, rawBody) => {
      const response = await handler(event(payload, { rawBody }));

      expect(response.statusCode).toBe(400);
      expect(body(response).error.code).toBe('BAD_REQUEST');
      expect(getTicket).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['too short', 'short'],
      ['too long', 'k'.repeat(129)],
    ])('answers 400 when the Idempotency-Key is %s', async (_label, key) => {
      const response = await handler(
        event({ sourceTicketIds: ['tkt_dup1'] }, { key }),
      );

      expect(response.statusCode).toBe(400);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('answers 401 without a valid staff token', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );

      const response = await merge();

      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });
  });
});
