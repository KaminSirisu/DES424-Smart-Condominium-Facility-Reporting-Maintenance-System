import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { getTicket, listTicketEvents } from '../shared/ticket-repository.js';
import { toEventView } from './event-view.js';
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  parseLimit,
  scalarParam,
  stringCursor,
} from './paging.js';
import { errorResponse, json, ticketIdFromPath } from './staff-http.js';
import { mayRead } from './ticket-access.js';
import { ApiError } from './types.js';

/**
 * GET /tickets/{ticketId}/events — the audit history of a ticket (SCFRMS-43;
 * the staff UI's History timeline).
 *
 * Contract: docs/api-specs/openapi.yaml (listTicketEvents, TicketEventPage).
 * Staff only: a technician reads the history of their team's tickets, a
 * manager of any ticket (RR-11). A reporter's LINE token is 401, as on every
 * staff endpoint. A ticket outside the technician's team is 403, as
 * openapi.yaml lists (the requirements document, SR-13, would answer 404),
 * and a ticket that does not exist is 404.
 *
 * Events come oldest first. `limit` is 1 to 100 (default 20) and `nextCursor`
 * is present only when there are more events; send it back as it is.
 */

const KNOWN_PARAMS = ['cursor', 'limit'];

function parseQuery(event: APIGatewayProxyEventV2): {
  limit: number;
  after?: string;
} {
  const params = new URLSearchParams(event.rawQueryString ?? '');
  for (const name of new Set(params.keys())) {
    if (!KNOWN_PARAMS.includes(name)) {
      throw badRequest(`Unknown query parameter: ${name}.`);
    }
  }
  const limit = parseLimit(scalarParam(params, 'limit'));
  const rawCursor = scalarParam(params, 'cursor');
  const after =
    rawCursor === undefined
      ? undefined
      : stringCursor(decodeCursor(rawCursor), 'e');
  return { limit, ...(after !== undefined ? { after } : {}) };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);
    const query = parseQuery(event);

    const ticket = await getTicket(ticketId);
    if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    if (!(await mayRead({ kind: 'staff', staff }, ticket))) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'You cannot read the history of this ticket.',
      );
    }

    const page = await listTicketEvents(ticketId, query);
    const body: { items: Record<string, unknown>[]; nextCursor?: string } = {
      items: page.events.map(toEventView),
    };
    if (page.next !== undefined)
      body.nextCursor = encodeCursor({ e: page.next });

    const response = json(200, body);
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'listTicketEvents',
    );
  }
}
