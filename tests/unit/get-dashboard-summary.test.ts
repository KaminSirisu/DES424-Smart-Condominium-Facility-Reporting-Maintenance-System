import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listTicketsOfMonths: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/get-dashboard-summary';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import { listTicketsOfMonths } from '../../backend/src/shared/ticket-repository';
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
    deadlineAt: '2026-11-12T08:00:00.000Z',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
    ...overrides,
  };
}

function event(who: StaffIdentity | null = manager): APIGatewayProxyEventV2 {
  return {
    headers: who ? { authorization: `Bearer ${signStaffToken(who)}` } : {},
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('GET /dashboard/summary', () => {
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
    vi.mocked(listTicketsOfMonths).mockResolvedValue([
      ticket('a'),
      ticket('b', {
        status: 'IN_PROGRESS',
        teamId: 'HVAC',
        deadlineAt: '2026-11-10T00:00:00.000Z',
      }),
      ticket('c', {
        status: 'RECEIVED',
        teamId: undefined,
        deadlineAt: undefined,
      }),
      ticket('d', { status: 'DONE' }),
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('gives a manager the counts, never cached', async () => {
    const response = await handler(event());

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
    expect(body(response)).toMatchObject({
      openCount: 3,
      overdueCount: 1,
      countsByStatus: {
        RECEIVED: 1,
        ASSIGNED: 1,
        IN_PROGRESS: 1,
        DONE: 1,
        MERGED: 0,
      },
      generatedAt: '2026-11-11T08:00:00.000Z',
    });
    expect(body(response).teamWorkloads).toContainEqual({
      teamId: 'HVAC',
      openCount: 1,
    });
    expect(body(response).teamWorkloads).toHaveLength(5);
  });

  it('reads the last 24 months, or as many as DASHBOARD_MAX_MONTHS says', async () => {
    await handler(event());
    const months = vi.mocked(listTicketsOfMonths).mock.calls[0][0];
    expect(months).toHaveLength(24);
    expect(months[0]).toBe('2026-11');
    expect(months[23]).toBe('2024-12');

    vi.stubEnv('DASHBOARD_MAX_MONTHS', '3');
    await handler(event());
    expect(vi.mocked(listTicketsOfMonths).mock.calls[1][0]).toEqual([
      '2026-11',
      '2026-10',
      '2026-09',
    ]);
  });

  it('shows no private field of a ticket', async () => {
    const response = await handler(event());
    expect(response.body).not.toContain('Ureporter');
    expect(response.body).not.toContain('location');
  });

  it('answers 403 to a technician and reads nothing', async () => {
    const response = await handler(event(technician));
    expect(response.statusCode).toBe(403);
    expect(listTicketsOfMonths).not.toHaveBeenCalled();
  });

  it('answers 401 for a token that is not a current staff token, such as a reporter', async () => {
    vi.mocked(requireStaff).mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
    );
    const response = await handler(event());
    expect(response.statusCode).toBe(401);
    expect(listTicketsOfMonths).not.toHaveBeenCalled();
  });

  it('needs a token', async () => {
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    expect((await handler(event(null))).statusCode).toBe(401);
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(listTicketsOfMonths).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
