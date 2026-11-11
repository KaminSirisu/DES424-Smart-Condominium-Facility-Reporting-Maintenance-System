import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { getTicket, listTeamTickets } from '../shared/ticket-repository.js';
import { isTeamId } from '../triage/policy.js';
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  OPEN_STATUSES,
  openCursor,
  parseLimit,
  scalarParam,
} from './paging.js';
import { errorResponse, json, ticketIdFromPath } from './staff-http.js';
import { mayRead } from './ticket-access.js';
import { toTicketView } from './ticket-view.js';
import { ApiError } from './types.js';

/**
 * GET /tickets/{ticketId}/duplicates — the open tickets that may describe the
 * same problem as this one (SCFRMS-44; the staff UI's "Possible duplicates at
 * this spot", which leads to the merge endpoint).
 *
 * Contract: docs/api-specs/openapi.yaml (listDuplicateCandidates, TicketPage),
 * proposed by the staff UI. The matching rule is the staff UI's: a ticket of
 * the same team, still ASSIGNED or IN_PROGRESS, with exactly the same location
 * text, not the ticket itself, oldest first. The requirements document (RR-08)
 * asks for one zone, but the system has free text locations and no zones, and
 * the team has not approved another rule. The list only suggests: the
 * technician confirms, and the merge endpoint checks its own rules.
 *
 * Scope: a technician of the ticket's team and a manager (read only); another
 * team's technician is 403 and a ticket that does not exist is 404. A ticket
 * that is not open (RECEIVED, DONE or MERGED) has no candidates: 200 with an
 * empty page, not an error. `limit` is 1 to 100 (default 20); `nextCursor` is
 * present only when there may be more, and is sent back as it is.
 */

const KNOWN_PARAMS = ['cursor', 'limit'];

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);

    const params = new URLSearchParams(event.rawQueryString ?? '');
    for (const name of new Set(params.keys())) {
      if (!KNOWN_PARAMS.includes(name)) {
        throw badRequest(`Unknown query parameter: ${name}.`);
      }
    }
    const limit = parseLimit(scalarParam(params, 'limit'));
    const rawCursor = scalarParam(params, 'cursor');
    const after =
      rawCursor === undefined ? {} : openCursor(decodeCursor(rawCursor));

    const ticket = await getTicket(ticketId);
    if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
    if (!(await mayRead({ kind: 'staff', staff }, ticket))) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'This ticket is not assigned to your team.',
      );
    }

    const body: { items: Record<string, unknown>[]; nextCursor?: string } = {
      items: [],
    };
    if (
      (OPEN_STATUSES as string[]).includes(ticket.status) &&
      isTeamId(ticket.teamId)
    ) {
      const page = await listTeamTickets(ticket.teamId, OPEN_STATUSES, {
        limit,
        after,
        filter: { location: ticket.location, excludeId: ticket.id },
      });
      body.items = page.tickets.map(toTicketView);
      if (page.next !== undefined) {
        body.nextCursor = encodeCursor({ o: page.next });
      }
    }

    const response = json(200, body);
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'listDuplicateCandidates',
    );
  }
}
