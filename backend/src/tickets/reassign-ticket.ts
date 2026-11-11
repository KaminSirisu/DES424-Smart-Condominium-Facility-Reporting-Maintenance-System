import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { getTicket, reassignTicket } from '../shared/ticket-repository.js';
import { computeDeadline, isTeamId, slaStartOf } from '../triage/policy.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, type TicketRecord } from './types.js';

/**
 * PATCH /tickets/{ticketId}/assignment — a manager moves a ticket to another
 * team, for example when the AI routed it wrongly (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (reassignTicket, ReassignTicket) and
 * the requirements document (RR-12, SLA-08). Only a manager may do it; a
 * technician gets 403. Only an ASSIGNED ticket can move, before work starts;
 * every other status is 409 (moving IN_PROGRESS work needs an exception policy
 * that does not exist yet, and a RECEIVED ticket has no team to take it from).
 * An unknown team is 422.
 *
 * The ticket leaves the old team's open queue and enters the new team's. The
 * deadline is counted again with the new team's SLA policy from the start of
 * the SLA clock (SLA-08). The `category` the AI chose stays as it is: it records
 * what the AI decided, and the team records what a person decided. A
 * REASSIGNED event records the old team, the new team, the manager and the
 * reason (required). No message is sent to anyone yet.
 *
 * Idempotency: asking for the team the ticket already has is 200 with the
 * ticket as it is and writes nothing, so a retry does not fail or write a
 * second event.
 */

const ALLOWED_FIELDS = ['teamId', 'reason'];
const REASON_MAX = 1000;

interface ReassignInput {
  teamId: string;
  reason: string;
}

function parseBody(event: APIGatewayProxyEventV2): ReassignInput {
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

  const { teamId, reason } = body;
  if (typeof teamId !== 'string' || teamId === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'teamId is required.');
  }
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > REASON_MAX
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `reason is required: text of 1 to ${REASON_MAX} characters.`,
    );
  }
  return { teamId, reason: reason.trim() };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);
    const input = parseBody(event);

    if (staff.role !== 'MANAGER') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a manager can move a ticket to another team.',
      );
    }
    if (!isTeamId(input.teamId)) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'teamId is not the id of a maintenance team.',
      );
    }

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }
    if (ticket.teamId === input.teamId) {
      return json(200, toTicketView(ticket));
    }
    if (ticket.status !== 'ASSIGNED' || !ticket.teamId) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${ticket.status} ticket cannot be moved to another team.`,
      );
    }

    const deadlineAt = ticket.priority
      ? computeDeadline(slaStartOf(ticket), input.teamId, ticket.priority)
      : undefined;
    const now = new Date().toISOString();
    const change = {
      toTeamId: input.teamId,
      accountId: staff.accountId,
      now,
      reason: input.reason,
      ...(deadlineAt && deadlineAt !== ticket.deadlineAt ? { deadlineAt } : {}),
    };
    try {
      await reassignTicket(ticket, change);
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // The ticket changed between our read and write; a retry may have won.
      const current = await getTicket(ticketId);
      if (current?.teamId === input.teamId) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket changed or work has started. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...ticket,
      teamId: input.teamId,
      updatedAt: now,
      version: ticket.version + 1,
      ...(change.deadlineAt ? { deadlineAt: change.deadlineAt } : {}),
    };
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'reassignTicket',
    );
  }
}
