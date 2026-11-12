import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../frontend/liff-app/src/utils/liff', () => ({
  getLineIdToken: vi.fn(async () => 'id-token-123'),
}));

import {
  API_BASE_URL,
  ApiError,
  submitErrorMessage,
  submitReport,
  type SubmitAttempt,
} from '../../frontend/liff-app/src/services/api';
import { getLineIdToken } from '../../frontend/liff-app/src/utils/liff';

const grant = {
  uploadId: 'upl_1',
  uploadUrl: 'https://bucket.s3.amazonaws.com/key?sig=abc',
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg', 'x-amz-meta-owner': 'o' },
  expiresAt: '2026-11-13T00:05:00Z',
};
const ticket = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water leaking near lift',
  status: 'RECEIVED',
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function photo(type = 'image/jpeg', size = 1234): File {
  return new File([new Uint8Array(size)], 'photo.jpg', { type });
}

function form(image = photo()) {
  return { location: 'Lobby', description: 'Water leaking near lift', image };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('submitReport', () => {
  it('requests a grant, uploads to S3, then creates the ticket', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, grant))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(201, ticket));
    const image = photo();
    const attempt: SubmitAttempt = { idempotencyKey: 'key-12345678' };

    const result = await submitReport(form(image), attempt);

    expect(result).toEqual(ticket);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe(`${API_BASE_URL}/uploads`);
    expect(uploadInit.method).toBe('POST');
    expect(uploadInit.headers.authorization).toBe('Bearer id-token-123');
    expect(JSON.parse(uploadInit.body)).toEqual({
      purpose: 'DEFECT',
      contentType: 'image/jpeg',
      sizeBytes: 1234,
    });

    const [s3Url, s3Init] = fetchMock.mock.calls[1];
    expect(s3Url).toBe(grant.uploadUrl);
    expect(s3Init.method).toBe('PUT');
    expect(s3Init.headers).toEqual(grant.headers);
    expect(s3Init.body).toBe(image);

    const [ticketUrl, ticketInit] = fetchMock.mock.calls[2];
    expect(ticketUrl).toBe(`${API_BASE_URL}/tickets`);
    expect(ticketInit.headers['idempotency-key']).toBe('key-12345678');
    expect(ticketInit.headers.authorization).toBe('Bearer id-token-123');
    expect(JSON.parse(ticketInit.body)).toEqual({
      location: 'Lobby',
      description: 'Water leaking near lift',
      defectPhotoUploadId: 'upl_1',
    });
    expect(attempt.uploadId).toBe('upl_1');
  });

  it('throws the API error from POST /uploads and stops', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: {
          code: 'UNPROCESSABLE',
          message: 'contentType must be image/jpeg or image/png.',
          requestId: 'req-1',
        },
      }),
    );

    const error = await submitReport(form(), {
      idempotencyKey: 'key-12345678',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'UNPROCESSABLE',
      message: 'contentType must be image/jpeg or image/png.',
      requestId: 'req-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on 401 from POST /uploads', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired LINE token.',
        },
      }),
    );

    await expect(
      submitReport(form(), { idempotencyKey: 'key-12345678' }),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not create a ticket when the S3 upload fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, grant))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const attempt: SubmitAttempt = { idempotencyKey: 'key-12345678' };

    await expect(submitReport(form(), attempt)).rejects.toMatchObject({
      status: 403,
      code: 'UPLOAD_FAILED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempt.uploadId).toBeUndefined();
  });

  it('reuses the upload and key when retrying after POST /tickets fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, grant))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(201, ticket));
    const attempt: SubmitAttempt = { idempotencyKey: 'key-12345678' };

    await expect(submitReport(form(), attempt)).rejects.toMatchObject({
      status: 500,
      code: 'HTTP_ERROR',
    });
    const result = await submitReport(form(), attempt);

    expect(result).toEqual(ticket);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [retryUrl, retryInit] = fetchMock.mock.calls[3];
    expect(retryUrl).toBe(`${API_BASE_URL}/tickets`);
    expect(retryInit.headers['idempotency-key']).toBe('key-12345678');
    expect(JSON.parse(retryInit.body).defectPhotoUploadId).toBe('upl_1');
  });

  it.each(['image/webp', 'image/heic', 'image/gif'])(
    'rejects %s before any network call',
    async (type) => {
      await expect(
        submitReport(form(photo(type)), { idempotencyKey: 'key-12345678' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getLineIdToken).not.toHaveBeenCalled();
    },
  );

  it('rejects a photo over 10 MB before any network call', async () => {
    await expect(
      submitReport(form(photo('image/png', 10 * 1024 * 1024 + 1)), {
        idempotencyKey: 'key-12345678',
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops when no LINE token is available', async () => {
    vi.mocked(getLineIdToken).mockRejectedValueOnce(
      new Error('Open this page in LINE to submit a report.'),
    );

    await expect(
      submitReport(form(), { idempotencyKey: 'key-12345678' }),
    ).rejects.toThrow('Open this page in LINE');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('submitErrorMessage', () => {
  it('asks to reopen LINE on 401', () => {
    expect(
      submitErrorMessage(new ApiError(401, 'UNAUTHORIZED', 'Invalid token')),
    ).toMatch(/session has expired/);
  });

  it('asks to wait on 429', () => {
    expect(submitErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x'))).toMatch(
      /wait/,
    );
  });

  it('shows the server message on 400/422', () => {
    expect(
      submitErrorMessage(new ApiError(422, 'UNPROCESSABLE', 'Bad photo.')),
    ).toBe('Bad photo.');
  });

  it('uses the generic text for network errors and 5xx', () => {
    const generic = 'Could not send your report. Please try again.';
    expect(submitErrorMessage(new TypeError('Failed to fetch'))).toBe(generic);
    expect(submitErrorMessage(new ApiError(500, 'HTTP_ERROR', 'x'))).toBe(
      generic,
    );
  });
});

describe('getLineIdToken', () => {
  const liffMock = {
    init: vi.fn(async () => undefined),
    getIDToken: vi.fn<() => string | null>(),
    getDecodedIDToken: vi.fn<() => { exp: number } | null>(),
  };

  async function loadReal() {
    vi.resetModules();
    vi.doMock('@line/liff', () => ({ default: liffMock }));
    return vi.importActual<
      typeof import('../../frontend/liff-app/src/utils/liff')
    >('../../frontend/liff-app/src/utils/liff');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@line/liff');
  });

  it('refuses in dev mode (no LIFF ID)', async () => {
    vi.stubEnv('VITE_LIFF_ID', '');
    const { getLineIdToken: real } = await loadReal();
    await expect(real()).rejects.toThrow('Open this page in LINE');
  });

  it('refuses when LIFF has no ID token', async () => {
    vi.stubEnv('VITE_LIFF_ID', '123-abc');
    liffMock.getIDToken.mockReturnValue(null);
    const { getLineIdToken: real } = await loadReal();
    await expect(real()).rejects.toThrow('Could not get your LINE login');
  });

  it('refuses an expired ID token', async () => {
    vi.stubEnv('VITE_LIFF_ID', '123-abc');
    liffMock.getIDToken.mockReturnValue('tok');
    liffMock.getDecodedIDToken.mockReturnValue({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const { getLineIdToken: real } = await loadReal();
    await expect(real()).rejects.toThrow('session has expired');
  });

  it('returns a valid ID token', async () => {
    vi.stubEnv('VITE_LIFF_ID', '123-abc');
    liffMock.getIDToken.mockReturnValue('tok');
    liffMock.getDecodedIDToken.mockReturnValue({
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const { getLineIdToken: real } = await loadReal();
    await expect(real()).resolves.toBe('tok');
    expect(liffMock.init).toHaveBeenCalledWith({
      liffId: '123-abc',
      withLoginOnExternalBrowser: true,
    });
  });
});
