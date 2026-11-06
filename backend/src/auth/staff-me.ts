import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { toStaffProfile } from '../shared/accounts.js';
import { requireStaffAccount } from '../shared/staff-auth.js';
import { errorResponse, json } from '../tickets/staff-http.js';

/**
 * GET /auth/staff/me — the logged-in staff member (SCFRMS-43).
 *
 * Contract: docs/api-specs/openapi.yaml (getCurrentStaff, StaffProfile). The
 * profile is read from the current account, not copied from the token, so a
 * changed display name shows at once. A bad token, a disabled account or an
 * old `token_version` is `401` (SR-10; see shared/staff-auth.ts).
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const account = await requireStaffAccount(event.headers?.authorization);
    return json(200, toStaffProfile(account));
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'getCurrentStaff',
    );
  }
}
