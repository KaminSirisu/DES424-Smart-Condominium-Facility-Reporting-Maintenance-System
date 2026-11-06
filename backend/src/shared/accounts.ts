import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isTeamId } from '../triage/policy.js';
import { ddb } from './dynamodb-client.js';
import type { StaffRole } from './staff-token.js';
import { tableName } from './tables.js';

/**
 * Staff accounts for the staff login (SR-07 to SR-10). Accounts table
 * (SCFRMS-28), one item per account:
 *
 *   PK `username` (normalized: trimmed, lower case)
 *
 * Attributes: accountId, role (TECHNICIAN or MANAGER), teamId (TECHNICIAN
 * only), displayName, passwordHash, isActive, tokenVersion, failedLoginCount,
 * lockedUntil, passwordChangedAt, lastLoginAt, createdAt, updatedAt. Times are
 * UTC ISO 8601 strings.
 *
 * Lockout (SR-09): the fifth failed login in a row locks the account for 15
 * minutes. The counter and the lock are conditional updates, so concurrent
 * wrong guesses cannot get more tries than the limit.
 */

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface AccountRecord {
  accountId: string;
  username: string;
  role: StaffRole;
  /** Present for a TECHNICIAN only. */
  teamId?: string;
  displayName: string;
  passwordHash: string;
  isActive: boolean;
  tokenVersion: number;
  failedLoginCount: number;
  /** While this time is in the future the account cannot log in. */
  lockedUntil?: string;
  passwordChangedAt: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** The account as the API shows it: StaffProfile in openapi.yaml, no secrets. */
export interface StaffProfile {
  id: string;
  name: string;
  role: StaffRole;
  /** Present for a TECHNICIAN only. */
  teamId?: string;
}

export function toStaffProfile(account: AccountRecord): StaffProfile {
  return {
    id: account.accountId,
    name: account.displayName,
    role: account.role,
    ...(account.teamId ? { teamId: account.teamId } : {}),
  };
}

export type FailedLoginResult =
  { locked: false } | { locked: true; lockedUntil: string };

/** The key form of a username: surrounding spaces removed, lower case. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** True while the account is inside a lockout period. */
export function isLocked(account: AccountRecord, now: Date): boolean {
  return (
    account.lockedUntil !== undefined &&
    Date.parse(account.lockedUntil) > now.getTime()
  );
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

function malformed(field: string): Error {
  return new Error(`Account record has an invalid ${field}.`);
}

function requiredString(item: Record<string, unknown>, field: string): string {
  const value = item[field];
  if (typeof value !== 'string' || value === '') throw malformed(field);
  return value;
}

function optionalString(
  item: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = item[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw malformed(field);
  return value;
}

function counter(item: Record<string, unknown>, field: string): number {
  const value = item[field] ?? 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw malformed(field);
  }
  return value;
}

/**
 * A stored item that does not fit the model is a data error, not a bad login:
 * it throws, so the caller answers 500 and the problem is seen and fixed
 * instead of the account silently not existing.
 */
function toAccount(item: Record<string, unknown>): AccountRecord {
  const role = item.role;
  if (role !== 'TECHNICIAN' && role !== 'MANAGER') throw malformed('role');

  const teamId = optionalString(item, 'teamId');
  if (role === 'TECHNICIAN' && (teamId === undefined || !isTeamId(teamId))) {
    throw malformed('teamId');
  }
  if (role === 'MANAGER' && teamId !== undefined) throw malformed('teamId');

  if (typeof item.isActive !== 'boolean') throw malformed('isActive');

  return {
    accountId: requiredString(item, 'accountId'),
    username: requiredString(item, 'username'),
    role,
    ...(teamId === undefined ? {} : { teamId }),
    displayName: requiredString(item, 'displayName'),
    passwordHash: requiredString(item, 'passwordHash'),
    isActive: item.isActive,
    tokenVersion: counter(item, 'tokenVersion'),
    failedLoginCount: counter(item, 'failedLoginCount'),
    lockedUntil: optionalString(item, 'lockedUntil'),
    passwordChangedAt: requiredString(item, 'passwordChangedAt'),
    lastLoginAt: optionalString(item, 'lastLoginAt'),
    createdAt: requiredString(item, 'createdAt'),
    updatedAt: requiredString(item, 'updatedAt'),
  };
}

/**
 * The account for this username, or null if there is none. The read is
 * strongly consistent so a fresh lockout or a disabled account is seen at
 * once.
 */
export async function getAccountByUsername(
  username: string,
): Promise<AccountRecord | null> {
  const key = normalizeUsername(username);
  if (key === '') return null;

  const result = await ddb.send(
    new GetCommand({
      TableName: tableName('ACCOUNTS'),
      Key: { username: key },
      ConsistentRead: true,
    }),
  );
  return result.Item ? toAccount(result.Item) : null;
}

/**
 * Counts one failed login. The fifth failure in a row sets `lockedUntil` and
 * restarts the count; the result says whether the account is now locked.
 * A username that does not exist is ignored, so this never creates an item.
 */
export async function recordFailedLogin(
  username: string,
  now: Date = new Date(),
): Promise<FailedLoginResult> {
  const key = { username: normalizeUsername(username) };
  const nowIso = now.toISOString();

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName('ACCOUNTS'),
        Key: key,
        UpdateExpression: 'SET updatedAt = :now ADD failedLoginCount :one',
        ConditionExpression:
          'attribute_exists(#username) AND (attribute_not_exists(failedLoginCount) OR failedLoginCount < :beforeLock)',
        ExpressionAttributeNames: { '#username': 'username' },
        ExpressionAttributeValues: {
          ':now': nowIso,
          ':one': 1,
          ':beforeLock': MAX_FAILED_LOGINS - 1,
        },
      }),
    );
    return { locked: false };
  } catch (err) {
    if (!isConditionalCheckFailure(err)) throw err;
  }

  // Either the account does not exist or this is the fifth failure.
  const lockedUntil = new Date(
    now.getTime() + LOCK_MINUTES * 60 * 1000,
  ).toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName('ACCOUNTS'),
        Key: key,
        UpdateExpression:
          'SET lockedUntil = :until, failedLoginCount = :zero, updatedAt = :now',
        ConditionExpression: 'attribute_exists(#username)',
        ExpressionAttributeNames: { '#username': 'username' },
        ExpressionAttributeValues: {
          ':until': lockedUntil,
          ':zero': 0,
          ':now': nowIso,
        },
      }),
    );
    return { locked: true, lockedUntil };
  } catch (err) {
    if (isConditionalCheckFailure(err)) return { locked: false };
    throw err;
  }
}

/** Clears the failure count and any lock, and records the login time. */
export async function recordSuccessfulLogin(
  username: string,
  now: Date = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName('ACCOUNTS'),
      Key: { username: normalizeUsername(username) },
      UpdateExpression:
        'SET lastLoginAt = :now, updatedAt = :now, failedLoginCount = :zero REMOVE lockedUntil',
      ConditionExpression: 'attribute_exists(#username)',
      ExpressionAttributeNames: { '#username': 'username' },
      ExpressionAttributeValues: { ':now': nowIso, ':zero': 0 },
    }),
  );
}
