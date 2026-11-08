import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { extractBearerToken, verifyLineToken } from '../shared/line-token.js';
import { requireStaff } from '../shared/staff-auth.js';
import { staffFromAuthorization } from '../shared/staff-token.js';
import { isReporterOf } from '../shared/ticket-reporters.js';
import { getTicket } from '../shared/ticket-repository.js';
import { errorResponse, json, ticketIdFromPath } from './staff-http.js';
import { toTicketView } from './ticket-view.js';
import { ApiError } from './types.js';

/**
 * GET /tickets/{ticketId} — one ticket, as far as the caller may see it
 * (SCFRMS-43; the staff UI's job page and the LIFF ticket page).
 *
 * Contract: docs/api-specs/openapi.yaml (getTicket, Ticket). Two kinds of
 * caller, told apart by the token: a staff token is checked against the
 * Accounts table (SR-10), anything else must be a LINE token of a reporter.
 *
 *   technician  the tickets of their team
 *   manager     every ticket
 *   reporter    the tickets they are a reporter of, including a ticket that
 *               was merged into another (it answers with mergedIntoTicketId)
 *
 * A ticket outside the caller's scope answers 404, the same as a ticket that
 * does not exist, so ids cannot be probed (SR-13; the staff UI expects 404 too).
 * The view never holds the reporter's LINE id or an S3 key (see ticket-view.ts).
 */

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
}

/** True when the token is a valid staff token (signature and expiry), whatever the account. */
function isStaffToken(authorization: string | undefined): boolean {
  try {
    staffFromAuthorization(authorization);
    return true;
  } catch (err) {
    if (err instanceof ApiError) return false;
    throw err;
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const authorization = event.headers?.authorization;
    const token = extractBearerToken(authorization);
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token.');
    }
    const ticketId = ticketIdFromPath(event);

    // A valid staff token never falls back to the LINE check: an account that
    // was disabled since the token was issued is a 401, not a reporter.
    const staff = isStaffToken(authorization)
      ? await requireStaff(authorization)
      : null;
    const reporterId = staff ? null : await verifyLineToken(token);

    const ticket = await getTicket(ticketId);
    if (!ticket) throw notFound();

    if (staff) {
      if (staff.role === 'TECHNICIAN' && ticket.teamId !== staff.teamId) {
        throw notFound();
      }
    } else if (!(await isReporterOf(ticketId, reporterId as string))) {
      throw notFound();
    }

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
