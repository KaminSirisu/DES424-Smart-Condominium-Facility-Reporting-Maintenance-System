// Backend API calls (API Gateway). Contract: docs/api-specs/openapi.yaml
import { getLineIdToken } from '../utils/liff';

const DEFAULT_API_BASE_URL =
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';

// Trailing slash removed so `${API_BASE_URL}/tickets` never has "//".
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL
).replace(/\/+$/, '');

// The backend accepts only these image types (backend/src/shared/upload-store.ts).
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export type ReportFormData = {
  location: string;
  image: File;
  description: string;
};

// One "submit" the user intends. Keep the same object when the user presses
// Submit again after an error, so the backend sees the same Idempotency-Key and
// upload, and never creates a second ticket for one report.
export type SubmitAttempt = {
  idempotencyKey: string;
  uploadId?: string;
};

export type UploadGrant = {
  uploadId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type Ticket = {
  id: string;
  location: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

// An error response from the API: { error: { code, message, requestId } }.
// status 0 means the request never got an answer (offline, CORS, S3 error).
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function isAllowedImageType(type: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    if (body.error?.message) {
      return new ApiError(
        response.status,
        body.error.code ?? 'ERROR',
        body.error.message,
        body.error.requestId,
      );
    }
  } catch {
    // Body was not JSON; fall through to a generic error.
  }
  return new ApiError(
    response.status,
    'HTTP_ERROR',
    `Request failed with HTTP ${response.status}.`,
  );
}

// POST /uploads: ask for a short-lived S3 URL for one defect photo.
export async function requestUploadGrant(
  token: string,
  file: File,
): Promise<UploadGrant> {
  const response = await fetch(`${API_BASE_URL}/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      purpose: 'DEFECT',
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });
  if (response.status !== 201) throw await parseError(response);
  return (await response.json()) as UploadGrant;
}

// PUT the file straight to S3 with the URL and headers from the grant.
// The URL is signed for that exact type and size, so send the headers as given.
export async function uploadToS3(
  grant: UploadGrant,
  file: File,
): Promise<void> {
  const response = await fetch(grant.uploadUrl, {
    method: grant.method,
    headers: grant.headers,
    body: file,
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'UPLOAD_FAILED',
      `Photo upload failed with HTTP ${response.status}.`,
    );
  }
}

// POST /tickets: create the report. Returns the ticket, status RECEIVED.
export async function createTicket(
  token: string,
  input: { location: string; description: string; defectPhotoUploadId: string },
  idempotencyKey: string,
): Promise<Ticket> {
  const response = await fetch(`${API_BASE_URL}/tickets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  if (response.status !== 201) throw await parseError(response);
  return (await response.json()) as Ticket;
}

// Full reporter flow: LINE token → upload grant → S3 PUT → create ticket.
// If the photo was already uploaded in an earlier try of this attempt, it is
// reused, because the backend rejects one Idempotency-Key with two uploads.
export async function submitReport(
  data: ReportFormData,
  attempt: SubmitAttempt,
): Promise<Ticket> {
  if (!isAllowedImageType(data.image.type)) {
    throw new ApiError(
      0,
      'UNSUPPORTED_IMAGE',
      'Please choose a JPEG or PNG photo.',
    );
  }
  if (data.image.size > MAX_IMAGE_BYTES) {
    throw new ApiError(0, 'IMAGE_TOO_LARGE', 'Photo must be 10 MB or smaller.');
  }

  const token = await getLineIdToken();

  if (!attempt.uploadId) {
    const grant = await requestUploadGrant(token, data.image);
    await uploadToS3(grant, data.image);
    attempt.uploadId = grant.uploadId;
  }

  return createTicket(
    token,
    {
      location: data.location,
      description: data.description,
      defectPhotoUploadId: attempt.uploadId,
    },
    attempt.idempotencyKey,
  );
}

// Turns an error from submitReport into a message for the reporter.
export function submitErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your LINE session has expired. Please close this page and open it again from LINE.';
    }
    if (error.status === 429) {
      return 'Too many reports in a short time. Please wait a moment and try again.';
    }
    if (error.status === 400 || error.status === 422 || error.status === 0) {
      return error.message;
    }
  } else if (error instanceof Error && !(error instanceof TypeError)) {
    // Errors from getLineIdToken already explain what to do.
    return error.message;
  }
  return 'Could not send your report. Please try again.';
}
