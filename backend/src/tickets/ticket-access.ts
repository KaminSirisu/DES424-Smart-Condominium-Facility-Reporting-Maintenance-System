import { extractBearerToken, verifyLineToken } from '../shared/line-token.js';
import { requireStaff } from '../shared/staff-auth.js';
import {
  staffFromAuthorization,
  type StaffIdentity,
} from '../shared/staff-token.js';
import { isReporterOf } from '../shared/ticket-reporters.js';
import { ApiError, type TicketRecord } from './types.js';

/**
 * Who is reading a ticket, and may they (SCFRMS-43). Shared by the endpoints
 * that serve a ticket or its photos to both staff and reporters.
 *
 * The two kinds of caller are told apart by the token: a staff token is
 * checked against the Accounts table (SR-10), anything else must be the LINE
 * token of a reporter.
 *
 *   technician  the tickets of their team
 *   manager     every ticket
 *   reporter    the tickets they are a reporter of, including a ticket that
 *               was merged into another
 */

export type Caller =
  | { kind: 'staff'; staff: StaffIdentity }
  | { kind: 'reporter'; lineUserId: string };

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

/** The verified caller, or a 401. */
export async function identifyCaller(
  authorization: string | undefined,
): Promise<Caller> {
  const token = extractBearerToken(authorization);
  if (!token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token.');
  }
  // A valid staff token never falls back to the LINE check: an account that
  // was disabled since the token was issued is a 401, not a reporter.
  if (isStaffToken(authorization)) {
    return { kind: 'staff', staff: await requireStaff(authorization) };
  }
  return { kind: 'reporter', lineUserId: await verifyLineToken(token) };
}

/** True when the caller's scope covers this ticket. */
export async function mayRead(
  caller: Caller,
  ticket: TicketRecord,
): Promise<boolean> {
  if (caller.kind === 'reporter') {
    return isReporterOf(ticket.id, caller.lineUserId);
  }
  const { role, teamId } = caller.staff;
  return (
    role === 'MANAGER' || (teamId !== undefined && ticket.teamId === teamId)
  );
}
