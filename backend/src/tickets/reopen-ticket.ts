import { createHash } from 'node:crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { extractBearerToken, verifyLineToken } from '../shared/line-token.js';
import { isReporterOf } from '../shared/ticket-reporters.js';
import { getTicket, reopenTicket } from '../shared/ticket-repository.js';
import { computeDeadline, isTeamId } from '../triage/policy.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, type TicketRecord } from './types.js';

/**
 * POST /tickets/{ticketId}/reopen — a reporter sends a finished repair back to
 * the team (SCFRMS-43; the Re-open button of the LINE completion message).
 *
 * Contract: docs/api-specs/openapi.yaml (reopenTicket, ReopenTicket). Only a
 * reporter of the ticket, identified by their LINE token, may do it, merged
 * tickets included (RR-03); anyone else gets 404, as for reading the ticket.
 *
 *  - The ticket must be DONE (409 otherwise) and done at most 7 days ago
 *    (RR-03; later a new report is needed, also 409).
 *  - It goes back to ASSIGNED, in the team's open queue, with `repairCycle`
 *    one higher, and a REOPENED event with the optional `reason` as its note.
 *  - A new resolution clock starts now with the same priority (SLA-10): the
 *    deadline is counted from the time of the reopen.
 *
 * Idempotency: `Idempotency-Key` is required (8 to 128 characters). A hash of
 * the key of the last reopen is kept on the ticket, so a retry of that
 * request is 200 with the ticket as it is, whatever has happened since, and
 * writes no second event. The LINE message "your report was reopened" is sent
 * from that event by the notification worker.
 */

export const REOPEN_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_MIN = 8;
const KEY_MAX = 128;
const REASON_MAX = 1000;

function idempotencyKey(event: APIGatewayProxyEventV2): string {
  const key = event.headers?.['idempotency-key']?.trim();
  if (!key || key.length < KEY_MIN || key.length > KEY_MAX) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Idempotency-Key header is required (${KEY_MIN} to ${KEY_MAX} characters).`,
    );
  }
  return key;
}

/** The optional `reason`, trimmed; an absent or empty body means none. */
function parseReason(event: APIGatewayProxyEventV2): string | undefined {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;
  if (raw === undefined || raw.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
  const unknownField = Object.keys(body).find((k) => k !== 'reason');
  if (unknownField) {
    throw new ApiError(400, 'BAD_REQUEST', `Unknown field: ${unknownField}.`);
  }
  const { reason } = body;
  if (reason === undefined) return undefined;
  if (typeof reason !== 'string' || reason.length > REASON_MAX) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `reason must be text of at most ${REASON_MAX} characters.`,
    );
  }
  return reason.trim() || undefined;
}

/** What is kept of the key: not the key itself, and tied to the ticket and the reporter. */
export function reopenKeyHash(
  ticketId: string,
  lineUserId: string,
  key: string,
): string {
  return createHash('sha256')
    .update(`${ticketId}\n${lineUserId}\n${key}`)
    .digest('hex');
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
    const ticketId = ticketIdFromPath(event);
    const key = idempotencyKey(event);
    const reason = parseReason(event);

    const ticket = await getTicket(ticketId);
    if (!ticket || !(await isReporterOf(ticketId, lineUserId))) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }

    const reopenKey = reopenKeyHash(ticketId, lineUserId, key);
    if (ticket.reopenKey === reopenKey) {
      return json(200, toTicketView(ticket));
    }
    if (ticket.status !== 'DONE') {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${ticket.status} ticket cannot be reopened.`,
      );
    }

    const now = new Date();
    const completed = Date.parse(ticket.completedAt ?? ticket.updatedAt);
    if (now.getTime() - completed > REOPEN_WINDOW_DAYS * DAY_MS) {
      throw new ApiError(
        409,
        'REOPEN_WINDOW_CLOSED',
        `A ticket can be reopened within ${REOPEN_WINDOW_DAYS} days of its completion. Please send a new report.`,
      );
    }
    if (!isTeamId(ticket.teamId)) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        'This ticket has no team and cannot be reopened.',
      );
    }

    const nowIso = now.toISOString();
    const deadlineAt = ticket.priority
      ? computeDeadline(nowIso, ticket.teamId, ticket.priority)
      : undefined;
    try {
      await reopenTicket(ticket, {
        now: nowIso,
        reopenKey,
        ...(reason ? { reason } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
      });
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // The ticket changed between our read and write; a retry may have won.
      const current = await getTicket(ticketId);
      if (current?.reopenKey === reopenKey) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket changed. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...ticket,
      status: 'ASSIGNED',
      repairCycle: ticket.repairCycle + 1,
      updatedAt: nowIso,
      version: ticket.version + 1,
      slaStartAt: nowIso,
      reopenKey,
      ...(deadlineAt ? { deadlineAt } : {}),
    };
    delete updated.completedAt;
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'reopenTicket',
    );
  }
}
