import { createHash } from 'node:crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { extractBearerToken, verifyLineToken } from '../shared/line-token';
import { createTicket, getTicket } from '../shared/ticket-repository';
import { UPLOAD_ID_PATTERN, uploadExists } from '../shared/upload-store';
import { ApiError, CreateTicketInput, TicketRecord } from './types';

/**
 * POST /tickets — submit a facility defect report (SCFRMS-40).
 *
 * Contract: docs/api-specs/openapi.yaml (createTicket). The ticket is stored
 * as RECEIVED with no category/priority/teamId/deadlineAt; AI triage
 * (SCFRMS-41) fills those in afterwards.
 *
 * Idempotency: the ticket id is derived from (lineUserId, Idempotency-Key),
 * so a retry targets the same item and the repository's conditional write
 * rejects the duplicate. A retry with the same payload gets the original
 * 201 back; the same key with a different payload is a 409.
 */

const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 128;
const DESCRIPTION_MAX = 2000;
const ALLOWED_FIELDS = ['location', 'description', 'defectPhotoUploadId'];

const VIEW_FIELDS = [
  'id',
  'location',
  'description',
  'status',
  'repairCycle',
  'photos',
  'category',
  'suggestedPriority',
  'priority',
  'teamId',
  'acceptedByStaffId',
  'acceptedAt',
  'deadlineAt',
  'completedAt',
  'mergedIntoTicketId',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof TicketRecord)[];

/**
 * Caller-safe view of a ticket. An allowlist, not a denylist: records read
 * back from DynamoDB also carry key attributes (PK, GSI2PK = REPORTER#<LINE
 * ID>, ...) that must never reach the caller.
 */
export function toTicketView(record: TicketRecord): Partial<TicketRecord> {
  const view: Partial<Record<string, unknown>> = {};
  for (const field of VIEW_FIELDS) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  return view as Partial<TicketRecord>;
}

export function deriveTicketId(
  lineUserId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${lineUserId}\n${idempotencyKey}`)
    .digest('hex')
    .slice(0, 26);
  return `tkt_${digest}`;
}

function parseBody(event: APIGatewayProxyEventV2): CreateTicketInput {
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

  const { location, description, defectPhotoUploadId } = body;
  if (typeof location !== 'string' || location.trim() === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'location is required.');
  }
  if (
    typeof description !== 'string' ||
    description.trim() === '' ||
    description.length > DESCRIPTION_MAX
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `description is required and at most ${DESCRIPTION_MAX} characters.`,
    );
  }
  if (typeof defectPhotoUploadId !== 'string' || defectPhotoUploadId === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'defectPhotoUploadId is required.');
  }

  return { location, description, defectPhotoUploadId };
}

function parseIdempotencyKey(event: APIGatewayProxyEventV2): string {
  const key = event.headers?.['idempotency-key']?.trim();
  if (
    !key ||
    key.length < IDEMPOTENCY_KEY_MIN ||
    key.length > IDEMPOTENCY_KEY_MAX
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Idempotency-Key header is required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters).`,
    );
  }
  return key;
}

function isSamePayload(existing: TicketRecord, input: CreateTicketInput) {
  return (
    existing.location === input.location &&
    existing.description === input.description &&
    existing.photos.some(
      (p) => p.purpose === 'DEFECT' && p.id === input.defectPhotoUploadId,
    )
  );
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

function json(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function created(record: TicketRecord): APIGatewayProxyStructuredResultV2 {
  return json(201, toTicketView(record), { Location: `/tickets/${record.id}` });
}

function replay(
  existing: TicketRecord,
  input: CreateTicketInput,
): APIGatewayProxyStructuredResultV2 {
  if (!isSamePayload(existing, input)) {
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key was already used with a different request.',
    );
  }
  return created(existing);
}

function errorResponse(
  err: unknown,
  requestId: string,
): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ApiError) {
    return json(err.statusCode, {
      error: { code: err.code, message: err.message, requestId },
    });
  }
  console.error('createTicket failed', { requestId, err });
  return json(500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error.',
      requestId,
    },
  });
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const token = extractBearerToken(event.headers?.authorization);
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token.');
    }
    const lineUserId = await verifyLineToken(token);

    const idempotencyKey = parseIdempotencyKey(event);
    const input = parseBody(event);
    const ticketId = deriveTicketId(lineUserId, idempotencyKey);

    // Fast path for retries: skip the S3 check and the write.
    const existing = await getTicket(ticketId);
    if (existing) {
      return replay(existing, input);
    }

    if (
      !UPLOAD_ID_PATTERN.test(input.defectPhotoUploadId) ||
      !(await uploadExists('DEFECT', lineUserId, input.defectPhotoUploadId))
    ) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'defectPhotoUploadId does not refer to a completed defect upload of yours.',
      );
    }

    const now = new Date().toISOString();
    const record: TicketRecord = {
      id: ticketId,
      location: input.location,
      description: input.description,
      status: 'RECEIVED',
      repairCycle: 1,
      photos: [
        { id: input.defectPhotoUploadId, purpose: 'DEFECT', addedAt: now },
      ],
      reporterLineUserId: lineUserId,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await createTicket(record);
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // Lost a race with a concurrent retry of the same request.
      const winner = await getTicket(ticketId);
      if (!winner) throw err;
      return replay(winner, input);
    }

    return created(record);
  } catch (err) {
    return errorResponse(err, event.requestContext?.requestId ?? 'unknown');
  }
}
