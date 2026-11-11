import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../tickets/types.js';
import { isTeamId } from '../triage/policy.js';
import { extractBearerToken } from './line-token.js';

/**
 * Staff session tokens (SCFRMS-43). The staff login (SR-08) issues a signed
 * JWT holding the account id, role, team and token version; every staff
 * endpoint takes the caller's role and team from this token only, never from
 * a request field.
 *
 * The token is a JWT signed with HMAC-SHA256 (HS256) using STAFF_JWT_SECRET,
 * which the login and the API share. Claims:
 *
 *   account_id     the shared team account or a manager account
 *   role           TECHNICIAN or MANAGER
 *   team_id        required for a TECHNICIAN, left out for a MANAGER
 *   token_version  raised on a password reset or disable (SR-10)
 *   iat, exp       seconds since the epoch; a token lives 12 hours at most
 *
 * Not checked here: that the account is still active and that token_version
 * is current (SR-10). That needs a read of the Accounts table and is done by
 * shared/staff-auth.ts, which every staff endpoint calls.
 */

export type StaffRole = 'TECHNICIAN' | 'MANAGER';

export interface StaffIdentity {
  accountId: string;
  role: StaffRole;
  /** Present for a TECHNICIAN only. */
  teamId?: string;
  tokenVersion: number;
}

export const STAFF_TOKEN_MAX_SECONDS = 12 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;

function unauthorized(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.');
}

function secret(): string {
  const value = process.env.STAFF_JWT_SECRET;
  if (!value) {
    throw new Error('STAFF_JWT_SECRET environment variable is not set.');
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `STAFF_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
  return value;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string): Buffer {
  return createHmac('sha256', secret()).update(signingInput).digest();
}

/**
 * A signed HS256 token holding these claims. Staff tokens and the short MFA
 * challenges (shared/mfa-challenge.ts) are made with this, so both are signed
 * with the same secret and told apart by their claims.
 */
export function signClaims(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const signingInput = `${header}.${base64url(JSON.stringify(claims))}`;
  return `${signingInput}.${base64url(sign(signingInput))}`;
}

/** Issues a token. The login uses this; tests use it to make valid tokens. */
export function signStaffToken(
  identity: StaffIdentity,
  now: Date = new Date(),
  ttlSeconds: number = STAFF_TOKEN_MAX_SECONDS,
): string {
  if (ttlSeconds < 1 || ttlSeconds > STAFF_TOKEN_MAX_SECONDS) {
    throw new Error('A staff token lives between 1 second and 12 hours.');
  }
  const iat = Math.floor(now.getTime() / 1000);
  const claims: Record<string, unknown> = {
    account_id: identity.accountId,
    role: identity.role,
    token_version: identity.tokenVersion,
    iat,
    exp: iat + ttlSeconds,
  };
  if (identity.teamId) claims.team_id = identity.teamId;
  return signClaims(claims);
}

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, 'base64url').toString('utf8'),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The claims of a token whose algorithm and signature are right, or null for
 * any other token. Whether the claims make sense, and whether the token has
 * expired, is for the caller to check.
 */
export function readSignedClaims(
  token: string,
): Record<string, unknown> | null {
  // A missing or weak secret is a server problem: fail loudly for every
  // request instead of answering 401 to some of them.
  secret();

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = parseJson(headerPart);
  // Only HS256: never accept "none" or another algorithm named by the token.
  if (!header || header.alg !== 'HS256') return null;

  const expected = sign(`${headerPart}.${payloadPart}`);
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return parseJson(payloadPart);
}

/**
 * Checks the signature, the expiry and the claims, and returns who the token
 * belongs to. Throws a 401 for any bad token, without saying why.
 */
export function verifyStaffToken(
  token: string,
  now: Date = new Date(),
): StaffIdentity {
  const claims = readSignedClaims(token);
  if (!claims) throw unauthorized();

  const { account_id, role, team_id, token_version, iat, exp } = claims;
  if (typeof account_id !== 'string' || account_id === '') throw unauthorized();
  if (role !== 'TECHNICIAN' && role !== 'MANAGER') throw unauthorized();
  if (!Number.isInteger(token_version) || (token_version as number) < 0) {
    throw unauthorized();
  }
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw unauthorized();

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt <= nowSeconds) throw unauthorized();
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) throw unauthorized();
  if (expiresAt - issuedAt > STAFF_TOKEN_MAX_SECONDS) throw unauthorized();

  const tokenVersion = token_version as number;
  if (role === 'TECHNICIAN') {
    if (!isTeamId(team_id)) throw unauthorized();
    return { accountId: account_id, role, teamId: team_id, tokenVersion };
  }
  return { accountId: account_id, role, tokenVersion };
}

/** The staff identity for an Authorization header, or a 401 when it is missing or bad. */
export function staffFromAuthorization(
  authorization: string | undefined,
  now: Date = new Date(),
): StaffIdentity {
  const token = extractBearerToken(authorization);
  if (!token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token.');
  }
  return verifyStaffToken(token, now);
}
