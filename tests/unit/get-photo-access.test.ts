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
vi.mock('../../backend/src/shared/proof-photo', () => ({
  photoAccess: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/get-photo-access';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import { isReporterOf } from '../../backend/src/shared/ticket-reporters';
import { getTicket } from '../../backend/src/shared/ticket-repository';
import { photoAccess } from '../../backend/src/shared/proof-photo';
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
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
};

const ACCESS = {
  url: 'https://signed.example/photo?sig=1',
  expiresAt: '2026-11-06T08:15:00.000Z',
};

function event(
  options: {
    identity?: StaffIdentity;
    token?: string | null;
    photoId?: string | null;
  } = {},
): APIGatewayProxyEventV2 {
  const token =
    options.token !== undefined
      ? options.token
      : options.identity
        ? signStaffToken(options.identity)
        : 'line.id.token';
  const photoId = options.photoId === undefined ? 'upl_1' : options.photoId;
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    pathParameters: {
      ticketId: 'tkt_1',
      ...(photoId === null ? {} : { photoId }),
    },
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('GET /tickets/{ticketId}/photos/{photoId}/access', () => {
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
    vi.mocked(photoAccess).mockResolvedValue(ACCESS);
  });

  describe('who may read a photo', () => {
    it('lets a technician read a photo of their own team', async () => {
      const response = await handler(event({ identity: technician }));

      expect(response.statusCode).toBe(200);
      expect(body(response)).toEqual(ACCESS);
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
      expect(photoAccess).toHaveBeenCalledWith(ticket, 'upl_1');
    });

    it('lets a manager read a photo of any team', async () => {
      const response = await handler(event({ identity: manager }));
      expect(response.statusCode).toBe(200);
    });

    it('lets a reporter read a photo of a ticket they reported', async () => {
      const response = await handler(event());

      expect(response.statusCode).toBe(200);
      expect(isReporterOf).toHaveBeenCalledWith('tkt_1', 'Ureporter');
    });

    it("answers 403 to a technician of another team and to a reporter who is not the ticket's", async () => {
      const staff = await handler(event({ identity: otherTeam }));
      expect(staff.statusCode).toBe(403);

      vi.mocked(isReporterOf).mockResolvedValue(false);
      const reporter = await handler(event());
      expect(reporter.statusCode).toBe(403);

      expect(photoAccess).not.toHaveBeenCalled();
    });
  });

  describe('a missing ticket or photo', () => {
    it('answers 404 for a ticket that does not exist', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      const response = await handler(event({ identity: technician }));

      expect(response.statusCode).toBe(404);
      expect(photoAccess).not.toHaveBeenCalled();
    });

    it('answers 404 for a photo the ticket does not have, or one that cannot be made viewable', async () => {
      vi.mocked(photoAccess).mockResolvedValue(null);
      const response = await handler(
        event({ identity: technician, photoId: 'nope' }),
      );

      expect(response.statusCode).toBe(404);
      expect(photoAccess).toHaveBeenCalledWith(ticket, 'nope');
    });
  });

  describe('authentication', () => {
    it('needs a bearer token', async () => {
      const response = await handler(event({ token: null }));
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('rejects a LINE token that does not verify', async () => {
      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      const response = await handler(event());
      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('rejects a staff token of a disabled account without trying LINE', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event({ identity: technician }));

      expect(response.statusCode).toBe(401);
      expect(verifyLineToken).not.toHaveBeenCalled();
    });
  });

  it('answers 400 when the photo id is missing or far too long', async () => {
    const missing = await handler(
      event({ identity: technician, photoId: null }),
    );
    const long = await handler(
      event({ identity: technician, photoId: 'x'.repeat(129) }),
    );

    expect(missing.statusCode).toBe(400);
    expect(long.statusCode).toBe(400);
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('answers 500 without details when the link cannot be made', async () => {
    vi.mocked(photoAccess).mockRejectedValue(new Error('S3 is down'));
    const response = await handler(event({ identity: technician }));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('S3');
  });
});
