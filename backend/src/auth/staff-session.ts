import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AccountRecord } from '../shared/accounts.js';
import { staffProfileOf } from '../shared/staff-profile.js';
import {
  signStaffToken,
  STAFF_TOKEN_MAX_SECONDS,
} from '../shared/staff-token.js';
import { json } from '../tickets/staff-http.js';

/**
 * The `200` answer that starts a staff session (StaffSession in openapi.yaml):
 * a 12 hour token and the profile. `tokenVersion` is the account's unless the
 * step that leads here has just raised it (the first MFA confirmation).
 */
export async function sessionResponse(
  account: AccountRecord,
  now: Date,
  tokenVersion: number = account.tokenVersion,
): Promise<APIGatewayProxyStructuredResultV2> {
  const accessToken = signStaffToken(
    {
      accountId: account.accountId,
      role: account.role,
      ...(account.teamId ? { teamId: account.teamId } : {}),
      tokenVersion,
    },
    now,
  );
  return noStore(
    json(200, {
      accessToken,
      expiresInSeconds: STAFF_TOKEN_MAX_SECONDS,
      staff: await staffProfileOf(account),
    }),
  );
}

/** A token or a secret must never be kept by a cache. */
export function noStore(
  response: APIGatewayProxyStructuredResultV2,
): APIGatewayProxyStructuredResultV2 {
  return {
    ...response,
    headers: { ...response.headers, 'cache-control': 'no-store' },
  };
}
