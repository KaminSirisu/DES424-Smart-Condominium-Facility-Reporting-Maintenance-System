import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError, type TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  changeTicketStatus: vi.fn(),
}));
vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/upload-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/upload-store')
  >()),
  uploadIsImage: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/set-status';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  signStaffToken,
  staffFromAuthorization,
} from '../../backend/src/shared/staff-token';
import type { StaffIdentity } from '../../backend/src/shared/staff-token';
import {
  changeTicketStatus,
  getTicket,
} from '../../backend/src/shared/ticket-repository';
import { uploadIsImage } from '../../backend/src/shared/upload-store';

const technician: StaffIdentity = {
  accountId: 'acct_plumbing',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 1,
};

function event(
  payload: unknown,
  identity: StaffIdentity | null = technician,
  rawBody?: string,
): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (identity) headers.authorization = `Bearer ${signStaffToken(identity)}`;
  return {
    headers,
    body: rawBody ?? JSON.stringify(payload),
    pathParameters: { ticketId: 'tkt_1' },
    requestContext: { requestId: 'req-1', http: { method: 'PATCH' } },
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
  version: 4,
  reporterLineUserId: 'Uabc123',
  category: 'PLUMBING',
  priority: 'MEDIUM',
  teamId: 'PLUMBING',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const inProgress: TicketRecord = {
  ...assigned,
  status: 'IN_PROGRESS',
  version: 5,
};

const done: TicketRecord = {
  ...inProgress,
  status: 'DONE',
  version: 6,
  completedAt: '2026-11-05T11:00:00.000Z',
  photos: [
    ...assigned.photos,
    {
      id: 'proof_1',
      purpose: 'REPAIR_PROOF',
      addedAt: '2026-11-05T11:00:00.000Z',
      repairCycle: 1,
      s3ObjectKey: 'uploads/REPAIR_PROOF/acct_plumbing/proof_1',
    },
  ],
};

const conflict = Object.assign(new Error('cancelled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}, {}],
});

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('PATCH /tickets/{ticketId}/status', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STAFF_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
    // The token check only; the Accounts check has its own tests (staff-auth).
    vi.mocked(requireStaff).mockImplementation(async (authorization) =>
      staffFromAuthorization(authorization),
    );
    vi.mocked(getTicket).mockResolvedValue(assigned);
    vi.mocked(changeTicketStatus).mockResolvedValue(undefined);
    vi.mocked(uploadIsImage).mockResolvedValue(true);
  });

  describe('start work', () => {
    it('moves ASSIGNED to IN_PROGRESS', async () => {
      const response = await handler(event({ status: 'IN_PROGRESS' }));

      expect(response.statusCode).toBe(200);
      expect(changeTicketStatus).toHaveBeenCalledWith(assigned, {
        to: 'IN_PROGRESS',
        accountId: 'acct_plumbing',
        now: expect.any(String),
      });
      expect(body(response)).toMatchObject({
        id: 'tkt_1',
        status: 'IN_PROGRESS',
      });
      expect(body(response)).not.toHaveProperty('reporterLineUserId');
      expect(uploadIsImage).not.toHaveBeenCalled();
    });

    it('is idempotent when the ticket already is IN_PROGRESS', async () => {
      vi.mocked(getTicket).mockResolvedValue(inProgress);
      const response = await handler(event({ status: 'IN_PROGRESS' }));
      expect(response.statusCode).toBe(200);
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });

    it('rejects a proof photo on IN_PROGRESS', async () => {
      const response = await handler(
        event({ status: 'IN_PROGRESS', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(400);
    });

    it('answers 409 for a DONE ticket', async () => {
      vi.mocked(getTicket).mockResolvedValue(done);
      const response = await handler(event({ status: 'IN_PROGRESS' }));
      expect(response.statusCode).toBe(409);
      expect(body(response).error.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('finish work', () => {
    beforeEach(() => {
      vi.mocked(getTicket).mockResolvedValue(inProgress);
    });

    it('moves IN_PROGRESS to DONE with a verified proof photo', async () => {
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );

      expect(response.statusCode).toBe(200);
      expect(uploadIsImage).toHaveBeenCalledWith(
        'REPAIR_PROOF',
        'acct_plumbing',
        'proof_1',
      );
      expect(changeTicketStatus).toHaveBeenCalledWith(inProgress, {
        to: 'DONE',
        accountId: 'acct_plumbing',
        now: expect.any(String),
        proof: {
          photoId: 'proof_1',
          s3ObjectKey: 'uploads/REPAIR_PROOF/acct_plumbing/proof_1',
        },
      });
      const ticket = body(response);
      expect(ticket.status).toBe('DONE');
      expect(ticket.completedAt).toEqual(expect.any(String));
      expect(ticket.photos).toContainEqual(
        expect.objectContaining({ id: 'proof_1', purpose: 'REPAIR_PROOF' }),
      );
      expect(JSON.stringify(ticket)).not.toContain('uploads/');
    });

    it('answers 400 when the proof photo is missing', async () => {
      const response = await handler(event({ status: 'DONE' }));
      expect(response.statusCode).toBe(400);
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });

    it('answers 422 when the upload is not a real image of theirs', async () => {
      vi.mocked(uploadIsImage).mockResolvedValue(false);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(422);
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });

    it('answers 422 for an upload id that is not a plain id', async () => {
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: '../other/owner' }),
      );
      expect(response.statusCode).toBe(422);
      expect(uploadIsImage).not.toHaveBeenCalled();
    });

    it('answers 409 when the work was not started', async () => {
      vi.mocked(getTicket).mockResolvedValue(assigned);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(409);
      expect(uploadIsImage).not.toHaveBeenCalled();
    });

    it('is idempotent for the same proof photo on a DONE ticket', async () => {
      vi.mocked(getTicket).mockResolvedValue(done);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(200);
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });

    it('answers 409 for a DONE ticket with a different proof photo', async () => {
      vi.mocked(getTicket).mockResolvedValue(done);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_2' }),
      );
      expect(response.statusCode).toBe(409);
    });

    it('answers 200 when a racing retry already finished it', async () => {
      vi.mocked(getTicket)
        .mockResolvedValueOnce(inProgress)
        .mockResolvedValueOnce(done);
      vi.mocked(changeTicketStatus).mockRejectedValue(conflict);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(200);
    });

    it('answers 409 when the proof photo was already used', async () => {
      vi.mocked(getTicket)
        .mockResolvedValueOnce(inProgress)
        .mockResolvedValueOnce(inProgress);
      vi.mocked(changeTicketStatus).mockRejectedValue(conflict);
      const response = await handler(
        event({ status: 'DONE', proofPhotoUploadId: 'proof_1' }),
      );
      expect(response.statusCode).toBe(409);
    });
  });

  describe('who may change the status', () => {
    it('answers 401 without a valid token', async () => {
      expect(
        (await handler(event({ status: 'IN_PROGRESS' }, null))).statusCode,
      ).toBe(401);
    });

    it('answers 401 when the account check fails, before reading the ticket', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );

      const response = await handler(event({ status: 'IN_PROGRESS' }));

      expect(response.statusCode).toBe(401);
      expect(getTicket).not.toHaveBeenCalled();
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });

    it('answers 403 to a manager', async () => {
      const response = await handler(
        event(
          { status: 'IN_PROGRESS' },
          { accountId: 'acct_mgr', role: 'MANAGER', tokenVersion: 1 },
        ),
      );
      expect(response.statusCode).toBe(403);
      expect(getTicket).not.toHaveBeenCalled();
    });

    it('answers 403 to a technician of another team', async () => {
      const response = await handler(
        event(
          { status: 'IN_PROGRESS' },
          { ...technician, accountId: 'acct_elec', teamId: 'ELECTRICAL' },
        ),
      );
      expect(response.statusCode).toBe(403);
    });

    it('lets any technician account of the team do it, and records which one', async () => {
      const response = await handler(
        event(
          { status: 'IN_PROGRESS' },
          { ...technician, accountId: 'acct_plumbing_2' },
        ),
      );
      expect(response.statusCode).toBe(200);
      expect(changeTicketStatus).toHaveBeenCalledWith(
        assigned,
        expect.objectContaining({ accountId: 'acct_plumbing_2' }),
      );
    });

    it('answers 404 for an unknown ticket', async () => {
      vi.mocked(getTicket).mockResolvedValue(null);
      expect((await handler(event({ status: 'IN_PROGRESS' }))).statusCode).toBe(
        404,
      );
    });
  });

  describe('request body', () => {
    it.each([
      ['invalid JSON', undefined, '{nope'],
      ['an array', [], undefined],
      ['an unknown status', { status: 'ASSIGNED' }, undefined],
      ['a missing status', {}, undefined],
      ['an unknown field', { status: 'IN_PROGRESS', note: 'x' }, undefined],
    ])('answers 400 for %s', async (_name, payload, raw) => {
      const response = await handler(event(payload, technician, raw));
      expect(response.statusCode).toBe(400);
      expect(changeTicketStatus).not.toHaveBeenCalled();
    });
  });

  it('answers 500 without details for an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(changeTicketStatus).mockRejectedValue(new Error('boom: secret'));
    const response = await handler(event({ status: 'IN_PROGRESS' }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });
});
