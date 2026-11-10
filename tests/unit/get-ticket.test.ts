import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  getTicket: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/get-ticket';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import { isReporterOf } from '../../backend/src/shared/ticket-reporters';
import { getTicket } from '../../backend/src/shared/ticket-repository';
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
  category: 'PLUMBING',
  priority: 'MEDIUM',
  prioritySetBy: 'AI',
  deadlineAt: '2026-11-06T08:00:00.000Z',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T08:05:00.000Z',
};

function event(
  options: {
    identity?: StaffIdentity;
    token?: string | null;
    ticketId?: string;
  } = {},
): APIGatewayProxyEventV2 {
  const { ticketId = 'tkt_1' } = options;
  const token =
    options.token !== undefined
      ? options.token
      : options.identity
        ? signStaffToken(options.identity)
        : 'line.id.token';
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    pathParameters: { ticketId },
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('GET /tickets/{ticketId}', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(verifyLineToken).mockResolvedValue('Ureporter');
    vi.mocked(isReporterOf).mockResolvedValue(true);
    vi.mocked(getTicket).mockResolvedValue(ticket);
  });

  describe('a technician', () => {
    it("reads a ticket of their team, without the reporter's id or the S3 key", async () => {
      const response = await handler(event({ identity: technician }));

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        status: 'ASSIGNED',
        teamId: 'PLUMBING',
        photos: [
          {
            id: 'upl_1',
            purpose: 'DEFECT',
            addedAt: '2026-11-05T08:00:00.000Z',
          },
        ],
      });
      expect(response.body).not.toContain('Ureporter');
      expect(response.body).not.toContain('s3ObjectKey');
      expect(response.body).not.toContain('version');
      expect(verifyLineToken).not.toHaveBeenCalled();
      expect(isReporterOf).not.toHaveBeenCalled();
    });

    it("gets 404 for another team's ticket, the same as for a ticket that does not exist", async () => {
      const outside = await handler(event({ identity: otherTeam }));

      vi.mocked(getTicket).mockResolvedValue(null);
      const missing = await handler(event({ identity: technician }));

      expect(outside.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(outside.body).toBe(missing.body);
    });

    it('gets 404 for a ticket that has no team yet', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
      });
      const response = await handler(event({ identity: technician }));
      expect(response.statusCode).toBe(404);
    });
  });

  it('does not match a technician without a team to a ticket without a team', async () => {
    vi.mocked(requireStaff).mockResolvedValue({
      accountId: 'x@example.com',
      role: 'TECHNICIAN',
      tokenVersion: 0,
    });
    vi.mocked(getTicket).mockResolvedValue({
      ...ticket,
      status: 'RECEIVED',
      teamId: undefined,
    });
    const response = await handler(event({ identity: technician }));
    expect(response.statusCode).toBe(404);
  });

  describe('a manager', () => {
    it('reads a ticket of any team', async () => {
      const response = await handler(event({ identity: manager }));
      expect(response.statusCode).toBe(200);

      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'RECEIVED',
        teamId: undefined,
      });
      const received = await handler(event({ identity: manager }));
      expect(received.statusCode).toBe(200);
    });
  });

  describe('a reporter', () => {
    it('reads a ticket they reported', async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(body(response).id).toBe('tkt_1');
      expect(verifyLineToken).toHaveBeenCalledWith('line.id.token');
      expect(isReporterOf).toHaveBeenCalledWith('tkt_1', 'Ureporter');
      expect(requireStaff).not.toHaveBeenCalled();
    });

    it('still reads a ticket that was merged into another, with mergedIntoTicketId', async () => {
      vi.mocked(getTicket).mockResolvedValue({
        ...ticket,
        status: 'MERGED',
        mergedIntoTicketId: 'tkt_main',
      });
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(body(response)).toMatchObject({
        status: 'MERGED',
        mergedIntoTicketId: 'tkt_main',
      });
    });

    it("gets 404 for someone else's ticket", async () => {
      vi.mocked(isReporterOf).mockResolvedValue(false);
      const response = await handler(event());

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Ureporter');
    });

    it('gets 404 for a ticket that does not exist, without checking reporters', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event());

      expect(response.statusCode).toBe(404);
      expect(isReporterOf).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('needs a bearer token', async () => {
      const response = await handler(event({ token: null }));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('rejects a token that is neither a staff token nor a LINE token', async () => {
      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      const response = await handler(event({ token: 'garbage' }));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('does not fall back to the LINE check for a staff token of a disabled account', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event({ identity: technician }));

      expect(response.statusCode).toBe(401);
      expect(verifyLineToken).not.toHaveBeenCalled();
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('does not let a staff token of the right team through when the account no longer matches', async () => {
      vi.mocked(requireStaff).mockResolvedValue(otherTeam);
      const response = await handler(event({ identity: technician }));
      expect(response.statusCode).toBe(404);
    });
  });

  it('answers 400 when the ticket id is missing', async () => {
    const response = await handler({
      ...event({ identity: technician }),
      pathParameters: {},
    });
    expect(response.statusCode).toBe(400);
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('answers 500 without details when the read fails', async () => {
    vi.mocked(getTicket).mockRejectedValue(new Error('dynamo down'));
    const response = await handler(event({ identity: technician }));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo');
  });
});
