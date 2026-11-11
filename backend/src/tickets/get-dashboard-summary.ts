import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { requireStaff } from '../shared/staff-auth.js';
import { listTicketsOfMonths } from '../shared/ticket-repository.js';
import { maxMonths, recentMonths, summarize } from './dashboard.js';
import { errorResponse, json } from './staff-http.js';
import { ApiError } from './types.js';

/**
 * GET /dashboard/summary — the current counts for the manager (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (getDashboardSummary,
 * DashboardSummary). Manager only; a technician gets 403. The counts are made
 * from the tickets of the last DASHBOARD_MAX_MONTHS months (default 24), read
 * from CreatedMonthIndex, so they are exact for that period and the period is
 * the limit of the report (see dashboard.ts). `overdueCount` counts ASSIGNED
 * and IN_PROGRESS tickets whose stored deadline has passed.
 */
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

    const now = new Date();
    const tickets = await listTicketsOfMonths(recentMonths(now, maxMonths()));

    const response = json(200, summarize(tickets, now));
    response.headers = { ...response.headers, 'cache-control': 'no-store' };
    return response;
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'getDashboardSummary',
    );
  }
}
