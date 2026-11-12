import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import {
  attachPhotos,
  listTicketsOfMonths,
} from '../shared/ticket-repository.js';
import { isTeamId } from '../triage/policy.js';
import {
  STATUSES,
  historyEntry,
  historyKey,
  historySummary,
  maxMonths,
  recentMonths,
} from './dashboard.js';
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  parseDate,
  parseLimit,
  scalarParam,
  stringCursor,
} from './paging.js';
import { errorResponse, json } from './staff-http.js';
import { ApiError, type TicketRecord, type TicketStatus } from './types.js';

/**
 * GET /dashboard/history — every ticket, current and past, with the totals
 * over all of them (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (getDashboardHistory,
 * DashboardHistory). Manager only (403 otherwise). Optional filters: `from` and
 * `to` (UTC dates, inclusive) on the creation time, `status`, `location` (the
 * exact text) and `teamId`. The `summary` counts every matching ticket; `items`
 * is one page of them, newest first, `limit` 1 to 100 (default 20), with an
 * opaque `nextCursor` when there are more.
 *
 * The tickets are read from CreatedMonthIndex, month by month, up to
 * DASHBOARD_MAX_MONTHS months back (default 24) and no further: `from` older
 * than that is 400, and without `from` the report starts at that limit. Every
 * request counts from the records, so the totals are exact for the period.
 */

const KNOWN_PARAMS = [
  'cursor',
  'limit',
  'from',
  'to',
  'status',
  'location',
  'teamId',
];
const DAY_MS = 24 * 60 * 60 * 1000;

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const staff = await requireStaff(event.headers?.authorization);
    if (staff.role !== 'MANAGER') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only a manager can read the dashboard.',
      );
    }

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
        : stringCursor(decodeCursor(rawCursor), 'h');

    const rawFrom = scalarParam(params, 'from');
    const rawTo = scalarParam(params, 'to');
    const from = rawFrom === undefined ? undefined : parseDate('from', rawFrom);
    const to = rawTo === undefined ? undefined : parseDate('to', rawTo);
    if (from && to && from.getTime() > to.getTime()) {
      throw badRequest('from must not be after to.');
    }

    const status = scalarParam(params, 'status');
    if (status !== undefined && !STATUSES.includes(status as TicketStatus)) {
      throw badRequest(`status ${status} is not a ticket status.`);
    }
    const location = scalarParam(params, 'location');
    const teamId = scalarParam(params, 'teamId');
    if (teamId !== undefined && !isTeamId(teamId)) {
      throw badRequest(`teamId ${teamId} is not a team id.`);
    }

    // The months to read: the report's period, narrowed by from and to.
    const now = new Date();
    const period = recentMonths(now, maxMonths());
    const oldest = period[period.length - 1];
    if (from && from.toISOString().slice(0, 7) < oldest) {
      throw badRequest(
        `from is older than the ${period.length} months this report covers (it starts at ${oldest}).`,
      );
    }
    const fromMonth = from ? from.toISOString().slice(0, 7) : oldest;
    const toMonth = to ? to.toISOString().slice(0, 7) : period[0];
    const months = period.filter((m) => m >= fromMonth && m <= toMonth);

    const lower = from?.toISOString();
    const upper = to
      ? new Date(to.getTime() + DAY_MS).toISOString()
      : undefined;
    const matching = (await listTicketsOfMonths(months)).filter(
      (t: TicketRecord) =>
        (lower === undefined || t.createdAt >= lower) &&
        (upper === undefined || t.createdAt < upper) &&
        (status === undefined || t.status === status) &&
        (location === undefined || t.location === location) &&
        (teamId === undefined || t.teamId === teamId),
    );

    // Newest first, as read; the page starts after the cursor's position.
    const rest =
      after === undefined
        ? matching
        : matching.filter((t) => historyKey(t) < after);
    const page = rest.slice(0, limit);

    const body: {
      items: Record<string, unknown>[];
      summary: ReturnType<typeof historySummary>;
      nextCursor?: string;
      generatedAt: string;
    } = {
      items: (await attachPhotos(page)).map(historyEntry),
      summary: historySummary(matching),
      generatedAt: now.toISOString(),
    };
    if (rest.length > limit) {
      body.nextCursor = encodeCursor({ h: historyKey(page[page.length - 1]) });
    }

    const response = json(200, body);
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'getDashboardHistory',
    );
  }
}
