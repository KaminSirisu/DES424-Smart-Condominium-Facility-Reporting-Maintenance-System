import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { getTicket, setTicketPriority } from '../shared/ticket-repository.js';
import { computeDeadline, isTeamId, slaStartOf } from '../triage/policy.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, type Priority, type TicketRecord } from './types.js';

/**
 * PATCH /tickets/{ticketId}/priority — a person decides the priority
 * (SCFRMS-43; the staff UI's "Accept" and "Update" in the priority box).
 *
 * Contract: docs/api-specs/openapi.yaml (setTicketPriority, SetPriority). A
 * technician of the ticket's team or a manager may do it (SLA-03; unlike the
 * status and merge endpoints, the manager is allowed here, as openapi.yaml and
 * the requirements document say). A technician of another team gets 403.
 * Only an ASSIGNED or IN_PROGRESS ticket can change; any other status is 409.
 *
 * `reason` is needed when the priority changes (400 without it) and optional
 * when the same priority is accepted, as the staff UI does. A change writes a
 * PRIORITY_CHANGED event, an acceptance a PRIORITY_CONFIRMED one; both set
 * `prioritySetBy` to STAFF and record the actor (SLA-03, SR-11).
 *
 * The deadline is counted again from the SLA start with the new priority
 * (SLA-07): from creation, or from the earlier start a merge took over
 * (SLA-09). A downgrade cannot reset the clock, and a deadline already past
 * stays past; the SLA engine (SCFRMS-42) will see that as a breach.
 *
 * Idempotency: asking for the priority the ticket already has, once a person
 * has set it, is 200 with the ticket as it is, so a retry does not fail or
 * write a second event.
 */

const PRIORITIES: Priority[] = ['CRITICAL', 'MEDIUM', 'LOW'];
const OPEN_STATUSES = ['ASSIGNED', 'IN_PROGRESS'];
const ALLOWED_FIELDS = ['priority', 'reason'];
const REASON_MAX = 1000;

interface SetPriorityInput {
  priority: Priority;
  reason?: string;
}

function parseBody(event: APIGatewayProxyEventV2): SetPriorityInput {
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

  const { priority, reason } = body;
  if (!PRIORITIES.includes(priority as Priority)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'priority must be CRITICAL, MEDIUM or LOW.',
    );
  }
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.length > REASON_MAX) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `reason must be text of at most ${REASON_MAX} characters.`,
      );
    }
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return {
    priority: priority as Priority,
    ...(trimmed ? { reason: trimmed } : {}),
  };
}

/** A person already set this very priority: nothing to write. */
function alreadySet(ticket: TicketRecord, priority: Priority): boolean {
  return ticket.priority === priority && ticket.prioritySetBy === 'STAFF';
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);
    const input = parseBody(event);

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }
    if (staff.role === 'TECHNICIAN' && ticket.teamId !== staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'This ticket is not assigned to your team.',
      );
    }
    if (alreadySet(ticket, input.priority)) {
      return json(200, toTicketView(ticket));
    }
    if (!OPEN_STATUSES.includes(ticket.status)) {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `The priority of a ${ticket.status} ticket cannot be changed.`,
      );
    }
    if (input.priority !== ticket.priority && !input.reason) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'reason is required when the priority changes.',
      );
    }

    const deadlineAt = isTeamId(ticket.teamId)
      ? computeDeadline(slaStartOf(ticket), ticket.teamId, input.priority)
      : undefined;
    const now = new Date().toISOString();
    const change = {
      to: input.priority,
      accountId: staff.accountId,
      ...(staff.teamId ? { teamId: staff.teamId } : {}),
      now,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(deadlineAt && deadlineAt !== ticket.deadlineAt ? { deadlineAt } : {}),
    };
    try {
      await setTicketPriority(ticket, change);
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // The ticket changed between our read and write; a retry may have won.
      const current = await getTicket(ticketId);
      if (current && alreadySet(current, input.priority)) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket changed or was closed. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...ticket,
      priority: input.priority,
      prioritySetBy: 'STAFF',
      updatedAt: now,
      version: ticket.version + 1,
      ...(change.deadlineAt ? { deadlineAt: change.deadlineAt } : {}),
    };
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'setTicketPriority',
    );
  }
}
