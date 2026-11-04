import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  acceptTicket: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/accept-ticket';
import { signStaffToken } from '../../backend/src/shared/staff-token';
import type { StaffIdentity } from '../../backend/src/shared/staff-token';
import {
  acceptTicket,
  getTicket,
} from '../../backend/src/shared/ticket-repository';

const technician: StaffIdentity = {
  accountId: 'acct_plumbing',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 1,
};

function event(
  identity: StaffIdentity | null = technician,
  overrides: { idempotencyKey?: string | null; ticketId?: string | null } = {},
): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (identity) headers.authorization = `Bearer ${signStaffToken(identity)}`;
  const key = overrides.idempotencyKey ?? 'idem-key-0001';
  if (overrides.idempotencyKey !== null) headers['idempotency-key'] = key;
  const ticketId =
    overrides.ticketId === undefined ? 'tkt_1' : overrides.ticketId;
  return {
    headers,
    pathParameters: ticketId === null ? {} : { ticketId },
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

const assigned: TicketRecord = {
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
      s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
    },
  ],
  version: 3,
  reporterLineUserId: 'Uabc123',
  category: 'PLUMBING',
  priority: 'MEDIUM',
  teamId: 'PLUMBING',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T08:01:00.000Z',
};

const accepted: TicketRecord = {
  ...assigned,
  version: 4,
  acceptedByStaffId: 'acct_plumbing',
  acceptedAt: '2026-11-05T09:00:00.000Z',
};

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('POST /tickets/{ticketId}/accept', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.mocked(getTicket).mockResolvedValue(assigned);
    vi.mocked(acceptTicket).mockResolvedValue(undefined);
  });

  it('accepts an ASSIGNED ticket of the technician team', async () => {
    const response = await handler(event());

    expect(response.statusCode).toBe(200);
    expect(acceptTicket).toHaveBeenCalledWith(
      assigned,
      'acct_plumbing',
      expect.any(String),
    );
    expect(body(response)).toMatchObject({
      id: 'tkt_1',
      status: 'ASSIGNED',
      acceptedByStaffId: 'acct_plumbing',
    });
    expect(body(response).acceptedAt).toEqual(expect.any(String));
    expect(body(response)).not.toHaveProperty('reporterLineUserId');
  });

  it('answers 401 without a token or with a bad one', async () => {
    expect((await handler(event(null))).statusCode).toBe(401);
    const bad = event();
    bad.headers.authorization = 'Bearer not-a-token';
    expect((await handler(bad)).statusCode).toBe(401);
    expect(acceptTicket).not.toHaveBeenCalled();
  });

  it('answers 403 to a manager', async () => {
    const response = await handler(
      event({ accountId: 'acct_mgr', role: 'MANAGER', tokenVersion: 1 }),
    );
    expect(response.statusCode).toBe(403);
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('answers 403 to a technician of another team', async () => {
    const response = await handler(
      event({ ...technician, accountId: 'acct_elec', teamId: 'ELECTRICAL' }),
    );
    expect(response.statusCode).toBe(403);
    expect(acceptTicket).not.toHaveBeenCalled();
  });

  it('answers 400 without an Idempotency-Key or ticket id', async () => {
    expect(
      (await handler(event(technician, { idempotencyKey: null }))).statusCode,
    ).toBe(400);
    expect(
      (await handler(event(technician, { idempotencyKey: 'short' })))
        .statusCode,
    ).toBe(400);
    expect(
      (await handler(event(technician, { ticketId: null }))).statusCode,
    ).toBe(400);
  });

  it('answers 404 for an unknown ticket', async () => {
    vi.mocked(getTicket).mockResolvedValue(null);
    expect((await handler(event())).statusCode).toBe(404);
  });

  it('answers 409 when another technician accepted it', async () => {
    vi.mocked(getTicket).mockResolvedValue({
      ...accepted,
      acceptedByStaffId: 'acct_someone_else',
    });
    const response = await handler(event());
    expect(response.statusCode).toBe(409);
    expect(body(response).error.code).toBe('ALREADY_ACCEPTED');
    expect(acceptTicket).not.toHaveBeenCalled();
  });

  it('answers 409 for a ticket that is not ASSIGNED', async () => {
    vi.mocked(getTicket).mockResolvedValue({ ...assigned, status: 'DONE' });
    expect((await handler(event())).statusCode).toBe(409);
    expect(acceptTicket).not.toHaveBeenCalled();
  });

  it('answers 409 for a ticket triage has not assigned yet', async () => {
    const received: TicketRecord = { ...assigned, status: 'RECEIVED' };
    delete received.teamId;
    vi.mocked(getTicket).mockResolvedValue(received);
    expect((await handler(event())).statusCode).toBe(409);
  });

  it('is idempotent for the account that already accepted', async () => {
    vi.mocked(getTicket).mockResolvedValue(accepted);
    const response = await handler(event());
    expect(response.statusCode).toBe(200);
    expect(body(response).acceptedAt).toBe('2026-11-05T09:00:00.000Z');
    expect(acceptTicket).not.toHaveBeenCalled();
  });

  it('answers 200 when a racing request of the same account won', async () => {
    vi.mocked(getTicket)
      .mockResolvedValueOnce(assigned)
      .mockResolvedValueOnce(accepted);
    vi.mocked(acceptTicket).mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
    );
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('answers 409 when another account won the race', async () => {
    vi.mocked(getTicket)
      .mockResolvedValueOnce(assigned)
      .mockResolvedValueOnce({ ...accepted, acceptedByStaffId: 'acct_other' });
    vi.mocked(acceptTicket).mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
    );
    expect((await handler(event())).statusCode).toBe(409);
  });

  it('answers 500 without details for an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(acceptTicket).mockRejectedValue(new Error('boom: secret'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });
});
