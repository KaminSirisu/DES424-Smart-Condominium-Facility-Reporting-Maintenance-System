import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  acceptMfaStep,
  confirmMfaEnrolment,
  storePendingMfaSecret,
} from '../shared/account-mfa.js';
import {
  getAccountByUsername,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  type AccountRecord,
} from '../shared/accounts.js';
import { verifyMfaChallenge } from '../shared/mfa-challenge.js';
import { decryptSecret, encryptSecret } from '../shared/mfa-secret.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../shared/totp.js';
import { errorResponse, json } from '../tickets/staff-http.js';
import { ApiError } from '../tickets/types.js';
import { parseJsonObject } from './json-body.js';
import { tooManyAttempts, wrongCode } from './login-errors.js';
import { noStore, sessionResponse } from './staff-session.js';

/**
 * The second step of a manager login (SR-09), after `POST /auth/staff/login`
 * answered `mfaRequired` with a challenge token (shared/mfa-challenge.ts):
 *
 *   POST /auth/staff/mfa/enroll   { challengeToken }        -> { secret, otpauthUri }
 *   POST /auth/staff/mfa/confirm  { challengeToken, code }  -> StaffSession
 *   POST /auth/staff/mfa/verify   { challengeToken, code }  -> StaffSession
 *
 * `enroll` is for a manager who has no authenticator yet: it makes a secret
 * and shows it once, for a QR code or typing in. The secret stays pending
 * until `confirm` receives the first correct code from it, which also logs the
 * manager in. A manager who already has an authenticator uses `verify`. The
 * first to enroll an account wins, so a new manager account should be set up
 * as soon as its password is handed over; a manager who loses the
 * authenticator is reset by another manager (PATCH /staff-accounts/{id}).
 *
 * Wrong codes count towards the same lockout as wrong passwords (5 in a row
 * lock the account for 15 minutes, `429`), a code is good once (a step that
 * was used cannot be used again), and a wrong, expired or stale challenge is
 * `401` without saying why. Secrets and codes are never logged.
 */

const ALLOWED_ENROLL = ['challengeToken'];
const ALLOWED_CODE = ['challengeToken', 'code'];
const CHALLENGE_MAX = 2000;

function badRequest(message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message);
}

function invalidStep(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired login step.');
}

function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message);
}

function challengeOf(body: Record<string, unknown>): string {
  const { challengeToken } = body;
  if (
    typeof challengeToken !== 'string' ||
    challengeToken === '' ||
    challengeToken.length > CHALLENGE_MAX
  ) {
    throw badRequest('challengeToken is required.');
  }
  return challengeToken;
}

function codeOf(body: Record<string, unknown>): string {
  const { code } = body;
  if (typeof code !== 'string' || !/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    throw badRequest('code must be the 6 digits from the authenticator app.');
  }
  return code;
}

/**
 * The manager a challenge is for, as the account is now. It must still be an
 * active manager at the version the password step saw, and not locked out.
 */
async function accountForChallenge(
  challengeToken: string,
  now: Date,
): Promise<AccountRecord> {
  const challenge = verifyMfaChallenge(challengeToken, now);
  const account = await getAccountByUsername(challenge.accountId);
  if (
    !account ||
    account.accountId !== challenge.accountId ||
    !account.isActive ||
    account.role !== 'MANAGER' ||
    account.tokenVersion !== challenge.tokenVersion
  ) {
    throw invalidStep();
  }
  if (isLocked(account, now) && account.lockedUntil) {
    throw tooManyAttempts(account.lockedUntil, now);
  }
  return account;
}

/** Counts a wrong code and answers `429` when it was the one that locks. */
async function refuseCode(account: AccountRecord, now: Date): Promise<never> {
  const failure = await recordFailedLogin(account.username, now);
  if (failure.locked) throw tooManyAttempts(failure.lockedUntil, now);
  throw wrongCode();
}

function run(
  operation: string,
  work: (
    event: APIGatewayProxyEventV2,
    now: Date,
  ) => Promise<APIGatewayProxyStructuredResultV2>,
) {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      return await work(event, new Date());
    } catch (err) {
      return errorResponse(
        err,
        event.requestContext?.requestId ?? 'unknown',
        operation,
      );
    }
  };
}

export const enrollHandler = run('enrollStaffMfa', async (event, now) => {
  const challengeToken = challengeOf(parseJsonObject(event, ALLOWED_ENROLL));
  const account = await accountForChallenge(challengeToken, now);
  if (account.mfaSecret !== undefined) {
    throw conflict(
      'MFA is already set up for this account. Ask another manager to reset it.',
    );
  }

  const secret = generateTotpSecret();
  const stored = await storePendingMfaSecret(
    account,
    encryptSecret(secret, account.accountId),
    now,
  );
  if (!stored) throw conflict('The account changed. Log in again.');

  return noStore(
    json(200, { secret, otpauthUri: otpauthUri(secret, account.username) }),
  );
});

export const confirmHandler = run('confirmStaffMfa', async (event, now) => {
  const body = parseJsonObject(event, ALLOWED_CODE);
  const challengeToken = challengeOf(body);
  const code = codeOf(body);
  const account = await accountForChallenge(challengeToken, now);
  if (account.mfaPendingSecret === undefined) {
    throw conflict('Start the MFA setup first.');
  }

  const secret = decryptSecret(account.mfaPendingSecret, account.accountId);
  const step = verifyTotp(secret, code, now);
  if (step === null) return refuseCode(account, now);

  // Raises the token version: this challenge is spent, and sessions that
  // began before MFA end.
  const tokenVersion = await confirmMfaEnrolment(account, step, now);
  if (tokenVersion === null) {
    throw conflict('The setup changed. Start it again.');
  }
  await recordSuccessfulLogin(account.username, now);
  return sessionResponse(account, now, tokenVersion);
});

export const verifyHandler = run('verifyStaffMfa', async (event, now) => {
  const body = parseJsonObject(event, ALLOWED_CODE);
  const challengeToken = challengeOf(body);
  const code = codeOf(body);
  const account = await accountForChallenge(challengeToken, now);
  if (account.mfaSecret === undefined) {
    throw conflict('MFA is not set up for this account. Set it up first.');
  }

  const secret = decryptSecret(account.mfaSecret, account.accountId);
  const step = verifyTotp(secret, code, now, account.mfaLastStep);
  if (step === null) return refuseCode(account, now);
  // The same code used twice at once: only the first one wins.
  if (!(await acceptMfaStep(account, step))) return refuseCode(account, now);

  await recordSuccessfulLogin(account.username, now);
  return sessionResponse(account, now);
});
