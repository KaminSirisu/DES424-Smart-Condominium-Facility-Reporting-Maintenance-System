import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { staffFromAuthorization } from '../shared/staff-token.js';
import { acceptTicket, getTicket } from '../shared/ticket-repository.js';
import {
  errorResponse,
  isConditionalCheckFailure,
  json,
  requireIdempotencyKey,
  ticketIdFromPath,
} from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, TicketRecord } from './types.js';

/**
 * POST /tickets/{ticketId}/accept — a technician accepts an ASSIGNED ticket
 * (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (acceptTicket). Only a TECHNICIAN of
 * the ticket's team may accept; a manager gets 403. Acceptance records the
 * account and the time without changing the status, so the ticket must be
 * ASSIGNED and not yet accepted by someone else (409).
 *
 * Idempotency: the same account accepting again gets 200 with the ticket as
 * it is. This is also the answer when two requests race and this one lost,
 * so a client retry never fails because its first attempt got through.
 */

function acceptedBy(ticket: TicketRecord, accountId: string): boolean {
  return ticket.acceptedByStaffId === accountId;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = staffFromAuthorization(event.headers?.authorization);
    requireIdempotencyKey(event);
    const ticketId = ticketIdFromPath(event);

    if (staff.role !== 'TECHNICIAN' || !staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a technician can accept a ticket.',
      );
    }

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    }
    if (ticket.teamId && ticket.teamId !== staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'This ticket is assigned to another team.',
      );
    }
    if (acceptedBy(ticket, staff.accountId)) {
      return json(200, toTicketView(ticket, 'STAFF'));
    }
    if (ticket.acceptedByStaffId) {
      throw new ApiError(
        409,
        'ALREADY_ACCEPTED',
        'Another technician has already accepted this ticket.',
      );
    }
    if (ticket.status !== 'ASSIGNED') {
      throw new ApiError(
        409,
        'INVALID_STATE',
        'Only an ASSIGNED ticket can be accepted.',
      );
    }

    const now = new Date().toISOString();
    try {
      await acceptTicket(ticket, staff.accountId, now);
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // Someone changed the ticket between our read and write.
      const current = await getTicket(ticketId);
      if (current && acceptedBy(current, staff.accountId)) {
        return json(200, toTicketView(current, 'STAFF'));
      }
      throw new ApiError(
        409,
        'CONFLICT',
        'The ticket changed. Reload it and try again.',
      );
    }

    return json(
      200,
      toTicketView(
        {
          ...ticket,
          acceptedByStaffId: staff.accountId,
          acceptedAt: now,
          updatedAt: now,
          version: ticket.version + 1,
        },
        'STAFF',
      ),
    );
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'acceptTicket',
    );
  }
}
