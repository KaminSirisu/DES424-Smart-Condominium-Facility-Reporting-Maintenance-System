import { ApiError } from '../tickets/types.js';
import { readSignedClaims, signClaims } from './staff-token.js';

/**
 * The short token a manager holds between the password step and the code step
 * of the login (SR-09). It is signed like a staff token, but it carries no
 * role, so no endpoint takes it as a staff login, and a staff token has no
 * `purpose`, so it is not taken as a challenge. It proves only that the
 * password was right a few minutes ago; the code step turns it into a staff
 * token. `token_version` ties it to the account as it was, so a password reset
 * or a disabled account kills the challenge too.
 */

export const MFA_CHALLENGE_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 60;
const PURPOSE = 'mfa';

export interface MfaChallenge {
  accountId: string;
  tokenVersion: number;
}

function invalid(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired login step.');
}

export function signMfaChallenge(
  challenge: MfaChallenge,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  return signClaims({
    purpose: PURPOSE,
    account_id: challenge.accountId,
    token_version: challenge.tokenVersion,
    iat,
    exp: iat + MFA_CHALLENGE_SECONDS,
  });
}

/** Who a challenge is for, or a 401 for any bad, expired or wrong kind of token. */
export function verifyMfaChallenge(
  token: string,
  now: Date = new Date(),
): MfaChallenge {
  const claims = readSignedClaims(token);
  if (!claims || claims.purpose !== PURPOSE) throw invalid();

  const { account_id, token_version, iat, exp } = claims;
  if (typeof account_id !== 'string' || account_id === '') throw invalid();
  if (!Number.isInteger(token_version) || (token_version as number) < 0) {
    throw invalid();
  }
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw invalid();

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt <= nowSeconds) throw invalid();
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) throw invalid();
  if (expiresAt - issuedAt > MFA_CHALLENGE_SECONDS) throw invalid();

  return { accountId: account_id, tokenVersion: token_version as number };
}
