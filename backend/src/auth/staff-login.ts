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
import { staffProfileOf } from '../shared/staff-profile.js';
import {
  signStaffToken,
  STAFF_TOKEN_MAX_SECONDS,
} from '../shared/staff-token.js';
import { errorResponse, json } from '../tickets/staff-http.js';
import { ApiError } from '../tickets/types.js';

/**
 * POST /auth/staff/login — start a staff session (SCFRMS-43, SR-07 to SR-10).
 *
 * Contract: docs/api-specs/openapi.yaml (loginStaff, StaffSession). The body
 * is `{ email, password }`; the email, trimmed and lower-cased, is the key of
 * the Accounts table (see shared/accounts.ts). On success the answer carries
 * a 12 hour staff token (shared/staff-token.ts) and the staff profile.
 *
 * A wrong email, a wrong password and a disabled account all get the same
 * `401` and message, so an answer never says which accounts exist. The five
 * failed logins in a row lock the account for 15 minutes (SR-09): while it is
 * locked, even the right password gets `429` with Retry-After. The per-IP
 * limit of SR-09 is an AWS WAF rule on API Gateway, not code.
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
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Request body must be a JSON object.',
    );
  }
  const body = parsed as Record<string, unknown>;

  const unknownField = Object.keys(body).find(
    (k) => !ALLOWED_FIELDS.includes(k),
  );
  if (unknownField) {
    throw new ApiError(400, 'BAD_REQUEST', `Unknown field: ${unknownField}.`);
  }

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

function wrongCredentials(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Incorrect email or password.');
}

function tooManyAttempts(lockedUntil: string, now: Date): ApiError {
  const seconds = Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 1000);
  return new ApiError(
    429,
    'RATE_LIMITED',
    'Too many failed logins. Please try again later.',
    { 'Retry-After': String(Math.max(1, seconds)) },
  );
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { email, password } = parseBody(event);
    const now = new Date();

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

    await recordSuccessfulLogin(account.username, now);

    const accessToken = signStaffToken(
      {
        accountId: account.accountId,
        role: account.role,
        ...(account.teamId ? { teamId: account.teamId } : {}),
        tokenVersion: account.tokenVersion,
      },
      now,
    );
    const response = json(200, {
      accessToken,
      expiresInSeconds: STAFF_TOKEN_MAX_SECONDS,
      staff: await staffProfileOf(account),
    });
    return {
      ...response,
      // A token must never be kept by a cache.
      headers: { ...response.headers, 'cache-control': 'no-store' },
    };
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'loginStaff',
    );
  }
}
