import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/line-token', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/line-token')
  >()),
  verifyLineToken: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-repository', () => ({
  createTicket: vi.fn(),
  getTicket: vi.fn(),
}));
vi.mock('../../backend/src/shared/rate-limit', () => ({
  consumeTicketQuota: vi.fn(),
}));
vi.mock('../../backend/src/shared/upload-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/upload-store')
  >()),
  uploadExists: vi.fn(),
}));

import { handler } from '../../backend/src/tickets/create-ticket';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { getTicket } from '../../backend/src/shared/ticket-repository';

/**
 * Retrying POST /tickets can happen long after the ticket was created, when a
 * technician has already accepted it. The reporter must not learn the staff
 * account from that replay (RR-04, openapi: staff-visible only).
 */
const body = {
  location: 'Lobby',
  description: 'Water is leaking.',
  defectPhotoUploadId: 'upl_1',
};

function event(): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    headers: {
      authorization: 'Bearer line-token',
      'idempotency-key': 'idem-key-0001',
    },
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

const acceptedTicket: TicketRecord = {
  id: 'tkt_1',
  location: body.location,
  description: body.description,
  status: 'IN_PROGRESS',
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
  teamId: 'PLUMBING',
  acceptedByStaffId: 'acct_plumbing',
  acceptedAt: '2026-11-05T09:00:00.000Z',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T09:30:00.000Z',
};

describe('POST /tickets replay after a technician accepted the ticket', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyLineToken).mockResolvedValue('Uabc123');
    vi.mocked(getTicket).mockResolvedValue(acceptedTicket);
  });

  it('returns the ticket without the accepting staff account', async () => {
    const response = await handler(event());

    expect(response.statusCode).toBe(201);
    const ticket = JSON.parse(response.body ?? '');
    expect(ticket).toMatchObject({
      status: 'IN_PROGRESS',
      acceptedAt: '2026-11-05T09:00:00.000Z',
    });
    expect(ticket).not.toHaveProperty('acceptedByStaffId');
    expect(response.body).not.toContain('acct_plumbing');
  });
});
