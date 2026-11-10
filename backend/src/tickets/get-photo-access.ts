import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { photoAccess } from '../shared/proof-photo.js';
import { getTicket } from '../shared/ticket-repository.js';
import { errorResponse, json, ticketIdFromPath } from './staff-http.js';
import { identifyCaller, mayRead } from './ticket-access.js';
import { ApiError } from './types.js';

/**
 * GET /tickets/{ticketId}/photos/{photoId}/access — a short-lived link to read
 * one photo of a ticket (SCFRMS-43; the staff UI's job page and the LIFF
 * "details and photo" page).
 *
 * Contract: docs/api-specs/openapi.yaml (getTicketPhotoAccess, PhotoAccess).
 * The caller's scope is the same as for the ticket (see ticket-access.ts):
 * a technician reads the photos of their team's tickets, a manager every
 * photo, a reporter the photos of the tickets they reported, defect photo and
 * repair proof both (RR-11, SR-23).
 *
 * The link points to a re-encoded JPEG copy without EXIF data, never to the
 * original (SR-22), and lives at most 15 minutes (SR-23); see
 * shared/proof-photo.ts. A ticket outside the caller's scope is 403, as the
 * staff UI and openapi.yaml list (the requirements document, SR-13, would
 * answer 404 so that ids cannot be probed; GET /tickets/{ticketId} does).
 * A ticket or a photo that does not exist, and a photo that cannot be made
 * viewable, are 404.
 */

const PHOTO_ID_MAX = 128;

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Photo not found.');
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const caller = await identifyCaller(event.headers?.authorization);
    const ticketId = ticketIdFromPath(event);
    const photoId = event.pathParameters?.photoId;
    if (!photoId || photoId.length > PHOTO_ID_MAX) {
      throw new ApiError(400, 'BAD_REQUEST', 'photoId is required.');
    }

    const ticket = await getTicket(ticketId);
    if (!ticket) throw notFound();
    if (!(await mayRead(caller, ticket))) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'You cannot view photos of this ticket.',
      );
    }

    const access = await photoAccess(ticket, photoId);
    if (!access) throw notFound();

    const response = json(200, access);
    // The URL is a credential: nothing may keep a copy of it.
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'getTicketPhotoAccess',
    );
  }
}
