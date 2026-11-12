import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError } from '../../backend/src/tickets/types';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/line-token', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/line-token')
  >()),
  verifyLineToken: vi.fn(),
}));
vi.mock(
  '../../backend/src/shared/ticket-repository',
  async (importOriginal) => ({
    QuotaExceededError: (
      await importOriginal<
        typeof import('../../backend/src/shared/ticket-repository')
      >()
    ).QuotaExceededError,
    createTicket: vi.fn(),
    getTicket: vi.fn(),
  }),
);
vi.mock('../../backend/src/shared/rate-limit', () => ({
  ticketQuotaClaim: vi.fn(),
  ticketIpQuotaClaim: vi.fn(),
}));
vi.mock('../../backend/src/shared/upload-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/upload-store')
  >()),
  uploadIsImage: vi.fn(),
}));

import {
  deriveTicketId,
  handler,
} from '../../backend/src/tickets/create-ticket';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import {
  QuotaExceededError,
  createTicket,
  getTicket,
} from '../../backend/src/shared/ticket-repository';
import {
  ticketIpQuotaClaim,
  ticketQuotaClaim,
} from '../../backend/src/shared/rate-limit';
import { uploadIsImage } from '../../backend/src/shared/upload-store';

const LINE_USER = 'Uabc123';
const CLAIM = {
  update: { TableName: 'RateLimits' },
  retryAfterSeconds: 1234,
} as unknown as ReturnType<typeof ticketQuotaClaim>;
const IP_CLAIM = {
  update: { TableName: 'RateLimits', Key: 'ip' },
  retryAfterSeconds: 99,
} as unknown as ReturnType<typeof ticketQuotaClaim>;
const KEY = 'idem-key-0001';
const validBody = {
  location: 'Beside the lobby elevator',
  description: 'Water is leaking beside the elevator.',
  defectPhotoUploadId: 'upl_123',
};

function makeEvent(
  overrides: {
    body?: unknown;
    headers?: Record<string, string | undefined>;
    sourceIp?: string;
  } = {},
): APIGatewayProxyEventV2 {
  const body = 'body' in overrides ? overrides.body : validBody;
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      authorization: 'Bearer line-token',
      'idempotency-key': KEY,
      ...overrides.headers,
    },
    requestContext: {
      requestId: 'req-1',
      http: {
        method: 'POST',
        ...(overrides.sourceIp ? { sourceIp: overrides.sourceIp } : {}),
      },
    },
  } as unknown as APIGatewayProxyEventV2;
}

function storedRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: deriveTicketId(LINE_USER, KEY),
    location: validBody.location,
    description: validBody.description,
    status: 'RECEIVED',
    repairCycle: 1,
    photos: [
      {
        id: 'upl_123',
        purpose: 'DEFECT',
        addedAt: '2026-10-28T00:00:00.000Z',
        s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_123',
      },
    ],
    version: 1,
    reporterLineUserId: LINE_USER,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /tickets (createTicket handler)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyLineToken).mockResolvedValue(LINE_USER);
    vi.mocked(getTicket).mockResolvedValue(null);
    vi.mocked(uploadIsImage).mockResolvedValue(true);
    vi.mocked(createTicket).mockResolvedValue(undefined);
    vi.mocked(ticketQuotaClaim).mockReturnValue(CLAIM);
    vi.mocked(ticketIpQuotaClaim).mockReturnValue(IP_CLAIM);
  });

  it('stores a RECEIVED ticket and returns a caller-safe 201', async () => {
    const response = await handler(makeEvent());

    expect(response.statusCode).toBe(201);
    const ticket = JSON.parse(response.body ?? '');
    expect(response.headers?.Location).toBe(`/tickets/${ticket.id}`);
    expect(ticket).toMatchObject({
      id: deriveTicketId(LINE_USER, KEY),
      location: validBody.location,
      description: validBody.description,
      status: 'RECEIVED',
      repairCycle: 1,
      photos: [{ id: 'upl_123', purpose: 'DEFECT' }],
    });
    for (const absent of [
      'reporterLineUserId',
      'category',
      'priority',
      'teamId',
      'deadlineAt',
      'safetyHazard',
    ]) {
      expect(ticket).not.toHaveProperty(absent);
    }
    expect(ticket).not.toHaveProperty('version');
    expect(response.body).not.toContain(LINE_USER);
    expect(response.body).not.toContain('s3ObjectKey');
    expect(response.body).not.toContain('uploads/');

    const saved = vi.mocked(createTicket).mock.calls[0][0];
    expect(saved.reporterLineUserId).toBe(LINE_USER);
    expect(saved.status).toBe('RECEIVED');
    expect(saved.version).toBe(1);
    expect(saved.photos[0].s3ObjectKey).toBe('uploads/DEFECT/Uabc123/upl_123');
    expect(uploadIsImage).toHaveBeenCalledWith('DEFECT', LINE_USER, 'upl_123');
  });

  describe('rate limit (SR-31)', () => {
    it('claims one creation for the verified reporter, written with the ticket', async () => {
      await handler(makeEvent());

      expect(ticketQuotaClaim).toHaveBeenCalledOnce();
      expect(ticketQuotaClaim).toHaveBeenCalledWith(LINE_USER);
      expect(createTicket).toHaveBeenCalledOnce();
      // No address in the event, so only the reporter is counted.
      expect(ticketIpQuotaClaim).not.toHaveBeenCalled();
      expect(vi.mocked(createTicket).mock.calls[0][1]).toEqual([CLAIM]);
    });

    it('also claims one creation for the address API Gateway saw, in the same transaction', async () => {
      await handler(makeEvent({ sourceIp: '203.0.113.7' }));

      expect(ticketIpQuotaClaim).toHaveBeenCalledOnce();
      expect(ticketIpQuotaClaim).toHaveBeenCalledWith('203.0.113.7');
      expect(createTicket).toHaveBeenCalledOnce();
      expect(vi.mocked(createTicket).mock.calls[0][1]).toEqual([
        CLAIM,
        IP_CLAIM,
      ]);
    });

    it('claims nothing for the address of a replay or a rejected request', async () => {
      vi.mocked(getTicket).mockResolvedValue(storedRecord());
      await handler(makeEvent({ sourceIp: '203.0.113.7' }));
      await handler(
        makeEvent({
          sourceIp: '203.0.113.7',
          headers: { authorization: undefined },
        }),
      );
      expect(ticketIpQuotaClaim).not.toHaveBeenCalled();
      expect(createTicket).not.toHaveBeenCalled();
    });

    it('returns 429 with Retry-After once the limit is used up', async () => {
      vi.mocked(createTicket).mockRejectedValue(new QuotaExceededError(1234));
      const response = await handler(makeEvent());

      expect(response.statusCode).toBe(429);
      expect(response.headers?.['Retry-After']).toBe('1234');
      expect(JSON.parse(response.body ?? '').error).toMatchObject({
        code: 'RATE_LIMITED',
        requestId: 'req-1',
      });
    });

    it('does not claim anything for a replay of an existing ticket', async () => {
      vi.mocked(getTicket).mockResolvedValue(storedRecord());
      await handler(makeEvent());
      expect(ticketQuotaClaim).not.toHaveBeenCalled();
      expect(createTicket).not.toHaveBeenCalled();
    });

    it('still replays when the limit is already used up', async () => {
      vi.mocked(getTicket).mockResolvedValue(storedRecord());
      vi.mocked(createTicket).mockRejectedValue(new QuotaExceededError(60));
      const response = await handler(makeEvent());
      expect(response.statusCode).toBe(201);
    });

    it('does not claim anything for requests rejected before a ticket would be created', async () => {
      await handler(makeEvent({ body: { ...validBody, location: ' ' } }));
      await handler(makeEvent({ headers: { authorization: undefined } }));
      vi.mocked(uploadIsImage).mockResolvedValue(false);
      await handler(makeEvent());
      expect(ticketQuotaClaim).not.toHaveBeenCalled();
      expect(createTicket).not.toHaveBeenCalled();
    });

    it('returns 500 when the ticket cannot be stored, and there is no separate count to take back', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(createTicket).mockRejectedValue(new Error('ddb down'));
      const response = await handler(makeEvent());

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('ddb down');
    });
  });

  it('returns 401 without a bearer token', async () => {
    const response = await handler(
      makeEvent({ headers: { authorization: undefined } }),
    );
    expect(response.statusCode).toBe(401);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('returns 401 when LINE rejects the token', async () => {
    vi.mocked(verifyLineToken).mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
    );
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body ?? '').error.requestId).toBe('req-1');
  });

  it.each([
    ['missing', undefined],
    ['too short', 'short'],
    ['too long', 'x'.repeat(129)],
  ])('returns 400 for a %s Idempotency-Key', async (_label, value) => {
    const response = await handler(
      makeEvent({ headers: { 'idempotency-key': value } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a non-object body', '[]'],
    ['a missing location', { ...validBody, location: undefined }],
    ['a blank location', { ...validBody, location: '   ' }],
    ['a missing description', { ...validBody, description: undefined }],
    [
      'an over-long description',
      { ...validBody, description: 'a'.repeat(2001) },
    ],
    ['a missing upload id', { ...validBody, defectPhotoUploadId: undefined }],
    ['an unknown field', { ...validBody, status: 'ASSIGNED' }],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await handler(makeEvent({ body }));
    expect(response.statusCode).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('returns 422 when the upload is not a completed DEFECT upload of this reporter', async () => {
    vi.mocked(uploadIsImage).mockResolvedValue(false);
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(422);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('returns 422 without touching S3 for a malformed upload id', async () => {
    const response = await handler(
      makeEvent({
        body: { ...validBody, defectPhotoUploadId: '../other/upl' },
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(uploadIsImage).not.toHaveBeenCalled();
  });

  it('replays the original ticket for a retry with the same key and payload', async () => {
    vi.mocked(getTicket).mockResolvedValue(storedRecord());
    const response = await handler(makeEvent());

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body ?? '').id).toBe(
      deriveTicketId(LINE_USER, KEY),
    );
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('does not leak DynamoDB key attributes when replaying a stored item', async () => {
    vi.mocked(getTicket).mockResolvedValue({
      ...storedRecord(),
      PK: 'TICKET#x',
      SK: 'METADATA',
      GSI2PK: `REPORTER#${LINE_USER}`,
      GSI2SK: 'CREATED#2026-10-28T00:00:00.000Z',
      entityType: 'TICKET',
    } as TicketRecord);
    const response = await handler(makeEvent());

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(LINE_USER);
    expect(response.body).not.toContain('s3ObjectKey');
    expect(response.body).not.toContain('uploads/');
    expect(JSON.parse(response.body ?? '')).not.toHaveProperty('PK');
  });

  it('does not expose the internal safetyHazard field when replaying a stored ticket', async () => {
    vi.mocked(getTicket).mockResolvedValue({
      ...storedRecord(),
      safetyHazard: 'GAS',
    });
    const response = await handler(makeEvent());

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body ?? '')).not.toHaveProperty('safetyHazard');
    expect(response.body).not.toContain('GAS');
  });

  it('returns 409 when the key was used with a different payload', async () => {
    vi.mocked(getTicket).mockResolvedValue(storedRecord());
    const response = await handler(
      makeEvent({ body: { ...validBody, description: 'Something else' } }),
    );
    expect(response.statusCode).toBe(409);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('replays when a concurrent retry wins the conditional write', async () => {
    vi.mocked(getTicket)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedRecord());
    vi.mocked(createTicket).mockRejectedValue(
      Object.assign(new Error('Transaction cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(201);
  });

  it('returns 500 when the transaction is cancelled for another reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createTicket).mockRejectedValue(
      Object.assign(new Error('Transaction cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ProvisionedThroughputExceeded' },
          { Code: 'None' },
        ],
      }),
    );
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(500);
  });

  it('derives different ticket ids for different reporters with the same key', () => {
    expect(deriveTicketId('Uaaa', KEY)).not.toBe(deriveTicketId('Ubbb', KEY));
    expect(deriveTicketId('Uaaa', KEY)).toBe(deriveTicketId('Uaaa', KEY));
  });

  it('returns 500 without leaking details on unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createTicket).mockRejectedValue(new Error('dynamo exploded'));
    const response = await handler(makeEvent());
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('dynamo exploded');
  });
});
