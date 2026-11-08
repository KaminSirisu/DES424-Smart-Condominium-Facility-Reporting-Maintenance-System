import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/line-token', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/line-token')
  >()),
  verifyLineToken: vi.fn(),
}));
vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/upload-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/upload-store')
  >()),
  createUploadGrant: vi.fn(),
}));

import { handler } from '../../backend/src/uploads/create-upload';
import { verifyLineToken } from '../../backend/src/shared/line-token';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import {
  UPLOAD_MAX_BYTES,
  createUploadGrant,
} from '../../backend/src/shared/upload-store';
import type { StaffIdentity } from '../../backend/src/shared/staff-token';

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

const GRANT = {
  uploadId: 'upl_1',
  uploadUrl: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc',
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  expiresAt: '2026-11-06T08:05:00.000Z',
};

function event(
  payload: unknown,
  options: { token?: string | null; rawBody?: string; base64?: boolean } = {},
): APIGatewayProxyEventV2 {
  const { token = 'some.token.value', rawBody } = options;
  const body = rawBody ?? JSON.stringify(payload);
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: options.base64 ?? false,
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

const defect = {
  purpose: 'DEFECT',
  contentType: 'image/jpeg',
  sizeBytes: 5000,
};
const proof = {
  purpose: 'REPAIR_PROOF',
  contentType: 'image/png',
  sizeBytes: 5000,
};

function body(response: { body?: string }) {
  return JSON.parse(response.body ?? '');
}

describe('POST /uploads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(verifyLineToken).mockResolvedValue('Ureporter');
    vi.mocked(requireStaff).mockResolvedValue(technician);
    vi.mocked(createUploadGrant).mockResolvedValue(GRANT as never);
  });

  describe('a defect photo (reporter)', () => {
    it('gives a reporter an upload grant owned by their LINE user id', async () => {
      const response = await handler(event(defect));

      expect(response.statusCode).toBe(201);
      expect(body(response)).toEqual(GRANT);
      expect(verifyLineToken).toHaveBeenCalledWith('some.token.value');
      expect(createUploadGrant).toHaveBeenCalledWith(
        'DEFECT',
        'Ureporter',
        'image/jpeg',
        5000,
      );
      expect(requireStaff).not.toHaveBeenCalled();
    });

    it('is never cached, because the URL is a credential', async () => {
      const response = await handler(event(defect));
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
    });

    it('needs a bearer token', async () => {
      const response = await handler(event(defect, { token: null }));
      expect(response.statusCode).toBe(401);
      expect(createUploadGrant).not.toHaveBeenCalled();
    });

    it('rejects a LINE token that does not verify', async () => {
      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      const response = await handler(event(defect));
      expect(response.statusCode).toBe(401);
      expect(createUploadGrant).not.toHaveBeenCalled();
    });
  });

  describe('a repair proof photo (technician)', () => {
    it('gives a technician an upload grant owned by their account id', async () => {
      const response = await handler(event(proof));

      expect(response.statusCode).toBe(201);
      expect(createUploadGrant).toHaveBeenCalledWith(
        'REPAIR_PROOF',
        'plumbing@example.com',
        'image/png',
        5000,
      );
      expect(verifyLineToken).not.toHaveBeenCalled();
    });

    it('refuses a manager with 403', async () => {
      vi.mocked(requireStaff).mockResolvedValue(manager);
      const response = await handler(event(proof));
      expect(response.statusCode).toBe(403);
      expect(createUploadGrant).not.toHaveBeenCalled();
    });

    it('refuses a technician without a team with 403', async () => {
      vi.mocked(requireStaff).mockResolvedValue({
        accountId: 'x@example.com',
        role: 'TECHNICIAN',
        tokenVersion: 0,
      });
      const response = await handler(event(proof));
      expect(response.statusCode).toBe(403);
    });

    it('refuses a token that is not a current staff token with 401', async () => {
      vi.mocked(requireStaff).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.'),
      );
      const response = await handler(event(proof));
      expect(response.statusCode).toBe(401);
      expect(createUploadGrant).not.toHaveBeenCalled();
    });
  });

  describe('the image limits (SR-20)', () => {
    it.each(['image/jpeg', 'image/png', 'image/webp'])(
      'accepts %s',
      async (contentType) => {
        const response = await handler(event({ ...defect, contentType }));
        expect(response.statusCode).toBe(201);
      },
    );

    it.each([
      'image/gif',
      'image/svg+xml',
      'application/pdf',
      'text/html',
      'IMAGE/JPEG',
    ])('answers 422 for %s', async (contentType) => {
      const response = await handler(event({ ...defect, contentType }));
      expect(response.statusCode).toBe(422);
      expect(createUploadGrant).not.toHaveBeenCalled();
    });

    it('accepts exactly 10 MB and answers 422 above it', async () => {
      const ok = await handler(
        event({ ...defect, sizeBytes: UPLOAD_MAX_BYTES }),
      );
      expect(ok.statusCode).toBe(201);

      const tooBig = await handler(
        event({ ...defect, sizeBytes: UPLOAD_MAX_BYTES + 1 }),
      );
      expect(tooBig.statusCode).toBe(422);
    });

    it('checks who is asking before it tells the limits', async () => {
      vi.mocked(verifyLineToken).mockRejectedValue(
        new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.'),
      );
      const response = await handler(
        event({ ...defect, contentType: 'image/gif' }),
      );
      expect(response.statusCode).toBe(401);
    });
  });

  describe('a bad request body', () => {
    it.each([
      ['not JSON', { rawBody: 'nope' }],
      ['a JSON array', { rawBody: '[]' }],
      [
        'an unknown field',
        { rawBody: JSON.stringify({ ...defect, key: 'x' }) },
      ],
      [
        'a missing purpose',
        { rawBody: JSON.stringify({ ...defect, purpose: undefined }) },
      ],
      [
        'an unknown purpose',
        { rawBody: JSON.stringify({ ...defect, purpose: 'AVATAR' }) },
      ],
      [
        'a missing contentType',
        { rawBody: JSON.stringify({ ...defect, contentType: undefined }) },
      ],
      [
        'an empty contentType',
        { rawBody: JSON.stringify({ ...defect, contentType: '' }) },
      ],
      ['a zero size', { rawBody: JSON.stringify({ ...defect, sizeBytes: 0 }) }],
      [
        'a fractional size',
        { rawBody: JSON.stringify({ ...defect, sizeBytes: 1.5 }) },
      ],
      [
        'a size given as text',
        { rawBody: JSON.stringify({ ...defect, sizeBytes: '10' }) },
      ],
    ])(
      'answers 400 for %s, before any token is checked',
      async (_label, options) => {
        const response = await handler(event(undefined, options));
        expect(response.statusCode).toBe(400);
        expect(verifyLineToken).not.toHaveBeenCalled();
        expect(requireStaff).not.toHaveBeenCalled();
      },
    );

    it('reads a base64 body', async () => {
      const response = await handler(event(defect, { base64: true }));
      expect(response.statusCode).toBe(201);
    });
  });

  it('answers 500 without details when the URL cannot be made', async () => {
    vi.mocked(createUploadGrant).mockRejectedValue(
      new Error('UPLOAD_BUCKET_NAME environment variable is not set.'),
    );
    const response = await handler(event(defect));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('UPLOAD_BUCKET_NAME');
    expect(body(response).error.code).toBe('INTERNAL_ERROR');
  });
});
