import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  listCompletedTickets,
  listReporterTickets,
  listTeamTickets,
  type OpenStatus,
  type TicketFilter,
  type TicketListPage,
} from '../shared/ticket-repository.js';
import { isTeamId } from '../triage/policy.js';
import { errorResponse, json } from './staff-http.js';
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  OPEN_STATUSES,
  openCursor,
  parseDate,
  parseLimit,
  scalarParam,
  stringCursor,
} from './paging.js';
import { identifyCaller } from './ticket-access.js';
import { toTicketView } from './ticket-view.js';
import { ApiError, type TicketRecord, type TicketStatus } from './types.js';

/**
 * GET /tickets — a page of the tickets the caller may see (SCFRMS-43; the
 * staff UI's "Team jobs" and "Completed" lists and the reporter's own list).
 *
 * Contract: docs/api-specs/openapi.yaml (listTickets, TicketPage).
 *
 *   reporter    their own tickets, merged sources included, newest first.
 *               Filters: status (repeatable), location (exact text). The staff
 *               filters (teamId, completedFrom, completedTo) are 403.
 *   technician  their team's tickets. status ASSIGNED and IN_PROGRESS (the
 *               default; repeatable) lists the open queue, oldest first;
 *               status DONE alone lists completed tickets, newest completion
 *               first, optionally within completedFrom..completedTo (UTC
 *               dates, inclusive). teamId, when given, must be their own (403).
 *   manager     the same, for the team named by teamId, which is required.
 *
 * The staff UI sends `status` more than once, so it is read from the raw query
 * string. Any other staff status (RECEIVED, MERGED) is 422: there is no index
 * for it yet, and DONE cannot be mixed with the open statuses. A page may hold
 * fewer than `limit` tickets while `nextCursor` is present, because filters are
 * applied after the index is read. The cursor is opaque; send it back as is.
 */

const STATUSES: TicketStatus[] = [
  'RECEIVED',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'MERGED',
];
const SCALAR_PARAMS = [
  'cursor',
  'limit',
  'location',
  'teamId',
  'completedFrom',
  'completedTo',
];
const KNOWN_PARAMS = [...SCALAR_PARAMS, 'status'];

interface Query {
  limit: number;
  cursor?: unknown;
  statuses?: TicketStatus[];
  location?: string;
  teamId?: string;
  completedFrom?: string;
  completedTo?: string;
}

function parseQuery(event: APIGatewayProxyEventV2): Query {
  const params = new URLSearchParams(event.rawQueryString ?? '');

  for (const name of new Set(params.keys())) {
    if (!KNOWN_PARAMS.includes(name)) {
      throw badRequest(`Unknown query parameter: ${name}.`);
    }
  }
  const scalar = (name: string): string | undefined =>
    scalarParam(params, name);

  const limit = parseLimit(scalar('limit'));

  const rawStatuses = params.getAll('status');
  const statuses = rawStatuses.length
    ? [...new Set(rawStatuses)].map((status) => {
        if (!STATUSES.includes(status as TicketStatus)) {
          throw badRequest(`status ${status} is not a ticket status.`);
        }
        return status as TicketStatus;
      })
    : undefined;

  const rawCursor = scalar('cursor');
  return {
    limit,
    ...(rawCursor !== undefined ? { cursor: decodeCursor(rawCursor) } : {}),
    ...(statuses ? { statuses } : {}),
    location: scalar('location'),
    teamId: scalar('teamId'),
    completedFrom: scalar('completedFrom'),
    completedTo: scalar('completedTo'),
  };
}

/** The page for a reporter. */
async function reporterPage(
  lineUserId: string,
  query: Query,
  filter: TicketFilter,
): Promise<TicketListPage<unknown>> {
  if (
    query.teamId !== undefined ||
    query.completedFrom !== undefined ||
    query.completedTo !== undefined
  ) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'teamId and the completed filters are for staff only.',
    );
  }
  const page = await listReporterTickets(lineUserId, {
    limit: query.limit,
    after: stringCursor(query.cursor, 'r'),
    filter,
  });
  return {
    tickets: page.tickets,
    ...(page.next ? { next: { r: page.next } } : {}),
  };
}

/** The page for a technician or a manager. */
async function staffPage(
  staff: { role: 'TECHNICIAN' | 'MANAGER'; teamId?: string },
  query: Query,
  filter: TicketFilter,
): Promise<TicketListPage<unknown>> {
  let teamId: string;
  if (staff.role === 'TECHNICIAN') {
    if (query.teamId !== undefined && query.teamId !== staff.teamId) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        "You cannot list another team's tickets.",
      );
    }
    teamId = staff.teamId as string;
  } else {
    if (query.teamId === undefined || !isTeamId(query.teamId)) {
      throw badRequest('teamId is required and must be a team id.');
    }
    teamId = query.teamId;
  }

  const statuses = query.statuses ?? OPEN_STATUSES;
  const wantsDone = statuses.includes('DONE');
  if (wantsDone && statuses.length > 1) {
    throw new ApiError(
      422,
      'UNPROCESSABLE',
      'status DONE cannot be combined with other statuses.',
    );
  }
  const unsupported = statuses.filter(
    (s) => s !== 'DONE' && !OPEN_STATUSES.includes(s as OpenStatus),
  );
  if (unsupported.length > 0) {
    throw new ApiError(
      422,
      'UNPROCESSABLE',
      `Staff can list ASSIGNED, IN_PROGRESS or DONE tickets, not ${unsupported.join(', ')}.`,
    );
  }

  if (!wantsDone) {
    if (query.completedFrom !== undefined || query.completedTo !== undefined) {
      throw badRequest('completedFrom and completedTo need status=DONE.');
    }
    const page = await listTeamTickets(teamId, statuses as OpenStatus[], {
      limit: query.limit,
      after: openCursor(query.cursor),
      filter: { location: filter.location },
    });
    return {
      tickets: page.tickets,
      ...(page.next ? { next: { o: page.next } } : {}),
    };
  }

  const from =
    query.completedFrom !== undefined
      ? parseDate('completedFrom', query.completedFrom).toISOString()
      : undefined;
  let toExclusive: string | undefined;
  if (query.completedTo !== undefined) {
    const end = parseDate('completedTo', query.completedTo);
    end.setUTCDate(end.getUTCDate() + 1);
    toExclusive = end.toISOString();
  }
  const page = await listCompletedTickets(teamId, {
    limit: query.limit,
    after: stringCursor(query.cursor, 'd'),
    from,
    toExclusive,
    filter: { location: filter.location },
  });
  return {
    tickets: page.tickets,
    ...(page.next ? { next: { d: page.next } } : {}),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const caller = await identifyCaller(event.headers?.authorization);
    const query = parseQuery(event);
    const filter: TicketFilter = {
      statuses: query.statuses,
      location: query.location,
    };

    const page =
      caller.kind === 'reporter'
        ? await reporterPage(caller.lineUserId, query, filter)
        : await staffPage(caller.staff, query, filter);

    const body: { items: Record<string, unknown>[]; nextCursor?: string } = {
      items: page.tickets.map((ticket: TicketRecord) => toTicketView(ticket)),
    };
    if (page.next !== undefined) body.nextCursor = encodeCursor(page.next);

    const response = json(200, body);
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'listTickets',
    );
  }
}
