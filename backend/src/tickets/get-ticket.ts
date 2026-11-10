import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getTicket } from '../shared/ticket-repository.js';
import { errorResponse, json, ticketIdFromPath } from './staff-http.js';
import { identifyCaller, mayRead } from './ticket-access.js';
import { toTicketView } from './ticket-view.js';
import { ApiError } from './types.js';

/**
 * GET /tickets/{ticketId} — one ticket, as far as the caller may see it
 * (SCFRMS-43; the staff UI's job page and the LIFF ticket page).
 *
 * Contract: docs/api-specs/openapi.yaml (getTicket, Ticket). A technician
 * reads the tickets of their team, a manager every ticket, and a reporter the
 * tickets they reported, a merged one included (it answers with
 * mergedIntoTicketId); see ticket-access.ts.
 *
 * A ticket outside the caller's scope answers 404, the same as a ticket that
 * does not exist, so ids cannot be probed (SR-13; the staff UI expects 404 too).
 * The view never holds the reporter's LINE id or an S3 key (see ticket-view.ts).
 */

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const caller = await identifyCaller(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);

    const ticket = await getTicket(ticketId);
    if (!ticket || !(await mayRead(caller, ticket))) throw notFound();

    const response = json(200, toTicketView(ticket));
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'getTicket',
    );
  }
}
