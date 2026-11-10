import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { changeTicketStatus, getTicket } from '../shared/ticket-repository.js';
import {
  UPLOAD_ID_PATTERN,
  uploadIsImage,
  uploadObjectKey,
} from '../shared/upload-store.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, TicketRecord } from './types.js';

/**
 * PATCH /tickets/{ticketId}/status — start or finish repair work (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (setTicketStatus, SetStatus). Work is
 * accepted by the team, not by a person (one shared account per team, SR-07):
 * any technician of the ticket's team moves ASSIGNED -> IN_PROGRESS -> DONE.
 * A manager and a technician of another team get 403, as openapi.yaml and the
 * staff UI expect (the requirements document would let a manager override a
 * status, RR-12, and answer 404 to another team, SR-13). The audit event
 * records the account and the team (SR-11).
 *
 * DONE needs `proofPhotoUploadId`: a REPAIR_PROOF upload owned by the calling
 * account whose first bytes are a real image (SR-21), else 422. The status
 * change, the proof photo, `completedAt` and the audit event are written in
 * one transaction (see shared/ticket-repository.ts).
 *
 * Idempotency: asking for the status the ticket already has (and, for DONE,
 * with the same proof photo) gets 200 with the ticket as it is, so a retry
 * after a lost response does not fail.
 */

type TargetStatus = 'IN_PROGRESS' | 'DONE';

interface SetStatusInput {
  status: TargetStatus;
  proofPhotoUploadId?: string;
}

const ALLOWED_FIELDS = ['status', 'proofPhotoUploadId'];

function parseBody(event: APIGatewayProxyEventV2): SetStatusInput {
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

  const { status, proofPhotoUploadId } = body;
  if (status !== 'IN_PROGRESS' && status !== 'DONE') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'status must be IN_PROGRESS or DONE.',
    );
  }
  if (status === 'DONE') {
    if (typeof proofPhotoUploadId !== 'string' || proofPhotoUploadId === '') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'proofPhotoUploadId is required when status is DONE.',
      );
    }
    return { status, proofPhotoUploadId };
  }
  if (proofPhotoUploadId !== undefined) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'proofPhotoUploadId is only allowed when status is DONE.',
    );
  }
  return { status };
}

/** True when the ticket already is what this request asks for. */
function alreadyDone(ticket: TicketRecord, input: SetStatusInput): boolean {
  if (input.status === 'IN_PROGRESS') {
    return ticket.status === 'IN_PROGRESS';
  }
  return (
    ticket.status === 'DONE' &&
    ticket.photos.some(
      (p) =>
        p.purpose === 'REPAIR_PROOF' &&
        p.id === input.proofPhotoUploadId &&
        p.repairCycle === ticket.repairCycle,
    )
  );
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);
    const input = parseBody(event);

    if (staff.role !== 'TECHNICIAN' || !staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a technician can change the status.',
      );
    }

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }
    if (ticket.teamId !== staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'This ticket is not assigned to your team.',
      );
    }
    if (alreadyDone(ticket, input)) {
      return json(200, toTicketView(ticket));
    }

    const expected = input.status === 'DONE' ? 'IN_PROGRESS' : 'ASSIGNED';
    if (ticket.status !== expected) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${ticket.status} ticket cannot be moved to ${input.status}.`,
      );
    }

    let proof: { photoId: string; s3ObjectKey: string } | undefined;
    if (input.status === 'DONE') {
      const uploadId = input.proofPhotoUploadId as string;
      if (
        !UPLOAD_ID_PATTERN.test(uploadId) ||
        !(await uploadIsImage('REPAIR_PROOF', staff.accountId, uploadId))
      ) {
        throw new ApiError(
          422,
          'UNPROCESSABLE',
          'proofPhotoUploadId does not refer to a completed repair-proof image upload of yours.',
        );
      }
      proof = {
        photoId: uploadId,
        s3ObjectKey: uploadObjectKey('REPAIR_PROOF', staff.accountId, uploadId),
      };
    }

    const now = new Date().toISOString();
    try {
      await changeTicketStatus(ticket, {
        to: input.status,
        accountId: staff.accountId,
        teamId: staff.teamId,
        now,
        ...(proof ? { proof } : {}),
      });
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // The ticket changed between our read and write; a retry may have won.
      const current = await getTicket(ticketId);
      if (current && alreadyDone(current, input)) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket changed or the proof photo was already used. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...ticket,
      status: input.status,
      updatedAt: now,
      version: ticket.version + 1,
      ...(input.status === 'DONE' ? { completedAt: now } : {}),
      photos: proof
        ? [
            ...ticket.photos,
            {
              id: proof.photoId,
              purpose: 'REPAIR_PROOF',
              addedAt: now,
              repairCycle: ticket.repairCycle,
              s3ObjectKey: proof.s3ObjectKey,
            },
          ]
        : ticket.photos,
    };
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'setTicketStatus',
    );
  }
}
