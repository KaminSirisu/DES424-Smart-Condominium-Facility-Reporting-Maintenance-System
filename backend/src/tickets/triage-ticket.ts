import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { parseJsonObject } from '../auth/json-body.js';
import { requireStaff } from '../shared/staff-auth.js';
import { applyTriage, getTicket } from '../shared/ticket-repository.js';
import {
  computeDeadline,
  isTeamId,
  SLA_POLICY_VERSION,
  type TeamId,
} from '../triage/policy.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, type Priority, type TicketRecord } from './types.js';

/**
 * PATCH /tickets/{ticketId}/triage — a manager triages a ticket by hand
 * (SCFRMS-42, RR-12, SR-33, SLA-06).
 *
 * Contract: docs/api-specs/openapi.yaml (triageTicket, TriageTicket). This is
 * for a ticket the automatic triage could not classify, which stays RECEIVED
 * with no team (and is listed for a manager by GET /tickets?status=RECEIVED).
 * Manager only: a technician gets 403, because the ticket belongs to no team
 * yet. The manager names the team and the priority; the category is the
 * team's name, as in the automatic triage.
 *
 * It does what the automatic triage does (shared/ticket-repository.ts,
 * applyTriage), in one transaction with a TRIAGED audit event: the ticket
 * becomes ASSIGNED, gets the team, the priority and a deadline counted from
 * creation (SLA-06: the clock started at creation, so slow triage counts), and
 * enters the team's open queue. `prioritySetBy` is STAFF and the event names the
 * manager (SR-11) and the reason, if one was given. The TRIAGED event also
 * starts the work order email to the team and the LINE message to the reporter,
 * like any triage.
 *
 * Only a RECEIVED ticket can be triaged (409 otherwise, for example when the
 * automatic triage just did it). Asking again for what a manager already set is
 * 200 with the ticket as it is, so a retry does not fail.
 */

const PRIORITIES: Priority[] = ['CRITICAL', 'MEDIUM', 'LOW'];
const ALLOWED_FIELDS = ['teamId', 'priority', 'reason'];
const REASON_MAX = 1000;

interface TriageInput {
  teamId: TeamId;
  priority: Priority;
  reason?: string;
}

function badRequest(message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message);
}

function parseBody(event: APIGatewayProxyEventV2): TriageInput {
  const body = parseJsonObject(event, ALLOWED_FIELDS);
  const { teamId, priority, reason } = body;

  if (!isTeamId(teamId)) {
    throw badRequest('teamId must be one of the maintenance teams.');
  }
  if (!PRIORITIES.includes(priority as Priority)) {
    throw badRequest('priority must be CRITICAL, MEDIUM or LOW.');
  }
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || reason.length > REASON_MAX)
  ) {
    throw badRequest(
      `reason must be text of at most ${REASON_MAX} characters.`,
    );
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return {
    teamId,
    priority: priority as Priority,
    ...(trimmed ? { reason: trimmed } : {}),
  };
}

/** A manager already triaged this ticket exactly so: nothing to write. */
function alreadyTriaged(ticket: TicketRecord, input: TriageInput): boolean {
  return (
    ticket.status === 'ASSIGNED' &&
    ticket.prioritySetBy === 'STAFF' &&
    ticket.teamId === input.teamId &&
    ticket.priority === input.priority
  );
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    if (staff.role !== 'MANAGER') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a manager can triage a ticket by hand.',
      );
    }
    const ticketId = ticketIdFromPath(event);
    const input = parseBody(event);

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }
    if (alreadyTriaged(ticket, input)) {
      return json(200, toTicketView(ticket));
    }
    if (ticket.status !== 'RECEIVED') {
      throw new ApiError(
        409,
        'INVALID_TRANSITION',
        `A ${ticket.status} ticket has been triaged already.`,
      );
    }

    const now = new Date().toISOString();
    // A RECEIVED ticket has never been reopened or merged, so its clock
    // started at creation.
    const deadlineAt = computeDeadline(
      ticket.createdAt,
      input.teamId,
      input.priority,
    );
    try {
      await applyTriage(ticketId, ticket.version, {
        category: input.teamId,
        priority: input.priority,
        teamId: input.teamId,
        deadlineAt,
        slaPolicyVersion: SLA_POLICY_VERSION,
        staff: {
          accountId: staff.accountId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        now,
      });
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // The ticket changed between our read and write: the automatic triage
      // or another manager may have just done it.
      const current = await getTicket(ticketId);
      if (current && alreadyTriaged(current, input)) {
        return json(200, toTicketView(current));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket was triaged or changed while you were working. Reload it and try again.',
      );
    }

    const updated: TicketRecord = {
      ...ticket,
      status: 'ASSIGNED',
      category: input.teamId,
      priority: input.priority,
      prioritySetBy: 'STAFF',
      teamId: input.teamId,
      deadlineAt,
      updatedAt: now,
      version: ticket.version + 1,
    };
    return json(200, toTicketView(updated));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'triageTicket',
    );
  }
}
