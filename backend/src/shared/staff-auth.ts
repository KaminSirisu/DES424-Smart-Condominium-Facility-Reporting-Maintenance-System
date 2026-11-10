import { getAccountByUsername, type AccountRecord } from './accounts.js';
import { staffFromAuthorization, type StaffIdentity } from './staff-token.js';
import { ApiError } from '../tickets/types.js';

/**
 * The check that every staff endpoint makes (SR-10). A valid signature is not
 * enough: the token is checked against the account in the Accounts table, so
 * disabling an account, resetting its password (which raises `tokenVersion`)
 * or changing its role or team stops its old tokens at once instead of when
 * they expire.
 *
 * The token's `account_id` is looked up as the Accounts key, so for now an
 * account's `accountId` is its normalized username. Anything that does not
 * match is the same `401` as a bad token, without saying why.
 */

function unauthorized(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.');
}

/** The current account for the Authorization header, or a 401. */
export async function requireStaffAccount(
  authorization: string | undefined,
  now: Date = new Date(),
): Promise<AccountRecord> {
  const claims = staffFromAuthorization(authorization, now);
  const account = await getAccountByUsername(claims.accountId);

  if (
    !account ||
    account.accountId !== claims.accountId ||
    !account.isActive ||
    account.tokenVersion !== claims.tokenVersion ||
    account.role !== claims.role ||
    account.teamId !== claims.teamId
  ) {
    throw unauthorized();
  }
  return account;
}

/** Who is calling, taken from the current account and not from the token. */
export async function requireStaff(
  authorization: string | undefined,
  now: Date = new Date(),
): Promise<StaffIdentity> {
  const account = await requireStaffAccount(authorization, now);
  return {
    accountId: account.accountId,
    role: account.role,
    ...(account.teamId ? { teamId: account.teamId } : {}),
    tokenVersion: account.tokenVersion,
  };
}
