import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { extractBearerToken, verifyLineToken } from '../shared/line-token.js';
import { requireStaff } from '../shared/staff-auth.js';
import {
  UPLOAD_CONTENT_TYPES,
  UPLOAD_MAX_BYTES,
  createUploadGrant,
} from '../shared/upload-store.js';
import { errorResponse, json } from '../tickets/staff-http.js';
import { ApiError, type PhotoPurpose } from '../tickets/types.js';

/**
 * POST /uploads — a short-lived URL to upload one image straight to S3
 * (SCFRMS-43, needed by SCFRMS-40 and the repair proof).
 *
 * Contract: docs/api-specs/openapi.yaml (createUploadIntent, UploadIntent,
 * UploadGrant). The purpose is bound to the caller's role (SR-14): a reporter,
 * who proves who they are with a LINE token, asks for DEFECT; a technician,
 * with a staff token, asks for REPAIR_PROOF. A manager gets 403, because only a
 * technician can finish a job (the requirements document would let a manager
 * ask too). The image must be JPEG, PNG or WebP of at most 10 MB (SR-20) or
 * the answer is 422.
 *
 * The URL is a presigned PUT that expires after 5 minutes (SR-19). The key is
 * chosen here (see shared/upload-store.ts) and the URL is signed with the
 * content type and the exact size, so S3 refuses any other file. The uploaded
 * object is checked again when a ticket or a status change uses its id (SR-21).
 */

const ALLOWED_FIELDS = ['purpose', 'contentType', 'sizeBytes'];

interface UploadIntent {
  purpose: PhotoPurpose;
  contentType: string;
  sizeBytes: number;
}

function parseBody(event: APIGatewayProxyEventV2): UploadIntent {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Request body must be a JSON object.',
    );
  }
  const body = parsed as Record<string, unknown>;

  const unknownField = Object.keys(body).find(
    (k) => !ALLOWED_FIELDS.includes(k),
  );
  if (unknownField) {
    throw new ApiError(400, 'BAD_REQUEST', `Unknown field: ${unknownField}.`);
  }

  const { purpose, contentType, sizeBytes } = body;
  if (purpose !== 'DEFECT' && purpose !== 'REPAIR_PROOF') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'purpose must be DEFECT or REPAIR_PROOF.',
    );
  }
  if (typeof contentType !== 'string' || contentType === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'contentType is required.');
  }
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 1
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'sizeBytes must be a whole number of at least 1.',
    );
  }
  return { purpose, contentType, sizeBytes };
}

/** Who owns the upload: the reporter's LINE user id or the technician's account id. */
async function ownerOf(
  purpose: PhotoPurpose,
  authorization: string | undefined,
): Promise<string> {
  if (purpose === 'DEFECT') {
    const token = extractBearerToken(authorization);
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token.');
    }
    return verifyLineToken(token);
  }

  const staff = await requireStaff(authorization);
  if (staff.role !== 'TECHNICIAN' || !staff.teamId) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only a technician can upload a repair proof.',
    );
  }
  return staff.accountId;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const intent = parseBody(event);
    const ownerId = await ownerOf(intent.purpose, event.headers?.authorization);

    if (
      !(UPLOAD_CONTENT_TYPES as readonly string[]).includes(intent.contentType)
    ) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'contentType must be image/jpeg, image/png or image/webp.',
      );
    }
    if (intent.sizeBytes > UPLOAD_MAX_BYTES) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        `sizeBytes must be at most ${UPLOAD_MAX_BYTES} (10 MB).`,
      );
    }

    const grant = await createUploadGrant(
      intent.purpose,
      ownerId,
      intent.contentType,
      intent.sizeBytes,
    );
    const response = json(201, grant);
    // The URL is a credential: nothing may keep a copy of it.
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'createUploadIntent',
    );
  }
}
