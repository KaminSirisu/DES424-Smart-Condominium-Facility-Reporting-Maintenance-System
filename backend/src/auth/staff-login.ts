import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  getAccountByUsername,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../shared/accounts.js';
import { verifyPassword } from '../shared/password.js';
import {
  MFA_CHALLENGE_SECONDS,
  signMfaChallenge,
} from '../shared/mfa-challenge.js';
import { managerMfaRequired } from '../shared/mfa-policy.js';
import { sourceIpOf } from '../shared/client-ip.js';
import { consumeLoginIpQuota } from '../shared/rate-limit.js';
import { errorResponse, json } from '../tickets/staff-http.js';
import { ApiError } from '../tickets/types.js';
import { parseJsonObject } from './json-body.js';
import { tooManyAttempts, wrongCredentials } from './login-errors.js';
import { noStore, sessionResponse } from './staff-session.js';

/**
 * POST /auth/staff/login — start a staff session (SCFRMS-43, SR-07 to SR-10).
 *
 * Contract: docs/api-specs/openapi.yaml (loginStaff, StaffSession). The body
 * is `{ email, password }`; the email, trimmed and lower-cased, is the key of
 * the Accounts table (see shared/accounts.ts). On success the answer carries
 * a 12 hour staff token (shared/staff-token.ts) and the staff profile.
 *
 * A manager needs a second step (SR-09, unless MANAGER_MFA_REQUIRED is
 * `false`): after the right password the answer is `{ mfaRequired: true,
 * mfaEnrolled, challengeToken, expiresInSeconds }` instead of a session, and
 * auth/staff-mfa.ts turns the challenge and a code into the session.
 *
 * A wrong email, a wrong password and a disabled account all get the same
 * `401` and message, so an answer never says which accounts exist. The five
 * failed logins in a row lock the account for 15 minutes (SR-09): while it is
 * locked, even the right password gets `429` with Retry-After. A second limit
 * is per address: 20 attempts per 15 minutes from one address (SR-09, counted
 * in shared/rate-limit.ts), also `429` with Retry-After.
 *
 * Passwords and tokens are never logged.
 */

const EMAIL_MAX = 254;
const PASSWORD_MAX = 128;
const ALLOWED_FIELDS = ['email', 'password'];

interface LoginInput {
  email: string;
  password: string;
}

function parseBody(event: APIGatewayProxyEventV2): LoginInput {
  const body = parseJsonObject(event, ALLOWED_FIELDS);

  const { email, password } = body;
  if (
    typeof email !== 'string' ||
    !email.includes('@') ||
    email.length > EMAIL_MAX
  ) {
    throw new ApiError(400, 'BAD_REQUEST', 'email must be a valid email.');
  }
  if (
    typeof password !== 'string' ||
    password === '' ||
    password.length > PASSWORD_MAX
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `password is required and at most ${PASSWORD_MAX} characters.`,
    );
  }
  return { email, password };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const now = new Date();

    // Counted first, so every attempt from an address counts, also one with a
    // wrong password or a body that cannot be read.
    const ip = sourceIpOf(event);
    if (ip) {
      const quota = await consumeLoginIpQuota(ip, now);
      if (!quota.allowed) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Too many login attempts from this address. Please try again later.',
          { 'Retry-After': String(quota.retryAfterSeconds) },
        );
      }
    }

    const { email, password } = parseBody(event);

    const account = await getAccountByUsername(email);
    if (account && isLocked(account, now) && account.lockedUntil) {
      throw tooManyAttempts(account.lockedUntil, now);
    }

    // For an unknown email this still does the work of a real check.
    const passwordMatches = await verifyPassword(
      password,
      account?.passwordHash ?? null,
    );
    if (!account || !passwordMatches) {
      if (account) {
        const failure = await recordFailedLogin(account.username, now);
        if (failure.locked) throw tooManyAttempts(failure.lockedUntil, now);
      }
      throw wrongCredentials();
    }
    if (!account.isActive) throw wrongCredentials();

    // A manager's password is only the first step (SR-09). The failed-login
    // count is left as it is until the code step succeeds, so wrong codes
    // count towards the same lockout and a right password cannot reset it.
    if (account.role === 'MANAGER' && managerMfaRequired()) {
      return noStore(
        json(200, {
          mfaRequired: true,
          mfaEnrolled: account.mfaSecret !== undefined,
          challengeToken: signMfaChallenge(
            {
              accountId: account.accountId,
              tokenVersion: account.tokenVersion,
            },
            now,
          ),
          expiresInSeconds: MFA_CHALLENGE_SECONDS,
        }),
      );
    }

    await recordSuccessfulLogin(account.username, now);
    return await sessionResponse(account, now);
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'loginStaff',
    );
  }
}
