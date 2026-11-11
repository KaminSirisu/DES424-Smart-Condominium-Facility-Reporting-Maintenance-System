import { randomUUID } from 'node:crypto';
import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isTeamId } from '../triage/policy.js';
import { ApiError } from '../tickets/types.js';
import {
  getAccountByUsername,
  isLocked,
  normalizeUsername,
  toAccountRecord,
  type AccountRecord,
} from './accounts.js';
import { ddb } from './dynamodb-client.js';
import type { StaffRole } from './staff-token.js';
import { tableName } from './tables.js';

/**
 * What a manager does to staff accounts (RR-13, SR-07). Every change is one
 * DynamoDB transaction made of three parts:
 *
 *   1. the change to the account, conditional on the account being as it was
 *      read (`tokenVersion` is the version stamp, and every change here raises
 *      it), so two managers acting at once cannot both win;
 *   2. a check that the manager who acts is still active, so a manager who was
 *      just disabled by another cannot finish a change;
 *   3. an audit event in the AccountEvents table.
 *
 * AccountEvents: PK `accountId` (the account that was changed) / SK `eventKey`
 * = `<occurredAt>#<eventId>`, with kind, actorAccountId and occurredAt. An event
 * never holds a password, a hash or a secret.
 *
 * Rules kept here, not in the handlers, so no caller can skip them:
 * - an account cannot disable itself, and a manager cannot reset its own MFA
 *   (that would let a stolen session switch the second factor off); the sole
 *   manager recovers through the reset script instead;
 * - disabling or resetting raises `tokenVersion`, which ends every session of
 *   the account at once (SR-10);
 * - at most one active TECHNICIAN account per team (SR-07). That one is a check
 *   before the write, not part of the transaction, so two managers creating the
 *   same team's account in the same instant could both succeed; a duplicate is
 *   visible in the list and can be disabled.
 */

export type AccountEventKind =
  | 'ACCOUNT_CREATED'
  | 'PASSWORD_RESET'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_ENABLED'
  | 'MFA_RESET'
  | 'MFA_ENROLLED';

export const MAX_DISPLAY_NAME_LENGTH = 100;

/** The account as the manager list shows it: nothing secret. */
export interface ManagedAccount {
  accountId: string;
  email: string;
  role: StaffRole;
  /** Present for a TECHNICIAN only. */
  teamId?: string;
  displayName: string;
  isActive: boolean;
  /** MANAGER only: true once an authenticator has been confirmed. */
  mfaEnabled?: boolean;
  /** Present while the account is locked out after failed logins. */
  lockedUntil?: string;
  lastLoginAt?: string;
  passwordChangedAt: string;
  createdAt: string;
}

export function toManagedAccount(
  account: AccountRecord,
  now: Date = new Date(),
): ManagedAccount {
  return {
    accountId: account.accountId,
    email: account.username,
    role: account.role,
    ...(account.teamId ? { teamId: account.teamId } : {}),
    displayName: account.displayName,
    isActive: account.isActive,
    ...(account.role === 'MANAGER'
      ? { mfaEnabled: account.mfaSecret !== undefined }
      : {}),
    ...(isLocked(account, now) && account.lockedUntil
      ? { lockedUntil: account.lockedUntil }
      : {}),
    ...(account.lastLoginAt ? { lastLoginAt: account.lastLoginAt } : {}),
    passwordChangedAt: account.passwordChangedAt,
    createdAt: account.createdAt,
  };
}

function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message);
}

function notFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Account not found.');
}

const CHANGED_MEANWHILE =
  'The account was changed by someone else. Reload it and try again.';

/**
 * Every account, managers first and then by email. The table is small (a few
 * managers and five team logins), so this reads all of it, page by page.
 */
export async function listAccounts(): Promise<AccountRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName('ACCOUNTS'),
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  // Read through the same reader as a login, so a damaged item is not hidden.
  return items.map(toAccountRecord).sort(byRoleThenEmail);
}

function byRoleThenEmail(a: AccountRecord, b: AccountRecord): number {
  if (a.role !== b.role) return a.role === 'MANAGER' ? -1 : 1;
  return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
}

export interface NewManagedAccount {
  /** The email: the key of the account (normalized) and its `accountId`. */
  email: string;
  role: StaffRole;
  /** Required for a TECHNICIAN, not allowed for a MANAGER. */
  teamId?: string;
  displayName: string;
  /** Already hashed (shared/password.ts). */
  passwordHash: string;
}

/** Rejects what the model cannot hold, so a bad value is a 400, never a 500. */
export function validateNewAccount(input: {
  email: unknown;
  role: unknown;
  teamId?: unknown;
  displayName: unknown;
}): void {
  const bad = (message: string) => new ApiError(400, 'BAD_REQUEST', message);
  const email =
    typeof input.email === 'string' ? normalizeUsername(input.email) : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw bad('email must be a valid email address.');
  }
  if (input.role !== 'TECHNICIAN' && input.role !== 'MANAGER') {
    throw bad('role must be TECHNICIAN or MANAGER.');
  }
  if (input.role === 'TECHNICIAN' && !isTeamId(input.teamId)) {
    throw bad('teamId must be one of the configured teams for a technician.');
  }
  if (input.role === 'MANAGER' && input.teamId !== undefined) {
    throw bad('A manager has no teamId.');
  }
  const name =
    typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (name === '' || name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw bad(
      `displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    );
  }
}

interface Change {
  /** The account that is changed. */
  target: AccountRecord;
  actorAccountId: string;
  kind: AccountEventKind;
  now: Date;
}

/** The audit event Put of a change. */
export function accountEventPut(
  accountId: string,
  kind: AccountEventKind,
  actor: string,
  now: Date,
) {
  const eventId = randomUUID();
  const occurredAt = now.toISOString();
  return {
    Put: {
      TableName: tableName('ACCOUNT_EVENTS'),
      Item: {
        accountId,
        eventKey: `${occurredAt}#${eventId}`,
        eventId,
        kind,
        occurredAt,
        actorAccountId: actor,
      },
    },
  };
}

/** True when a cancelled transaction failed its condition at `index`. */
function failedAt(err: unknown, index: number): boolean {
  const e = err as
    { name?: string; CancellationReasons?: { Code?: string }[] } | undefined;
  return (
    e?.name === 'TransactionCanceledException' &&
    e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed'
  );
}

/**
 * The check that the acting manager is still an active manager. When the
 * actor is the account being changed, DynamoDB does not allow two operations
 * on one item, so the update itself carries the check (see `selfGuard`).
 */
function actorCheck(actorAccountId: string) {
  return {
    ConditionCheck: {
      TableName: tableName('ACCOUNTS'),
      Key: { username: actorAccountId },
      ConditionExpression: 'isActive = :yes AND #role = :manager',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':yes': true, ':manager': 'MANAGER' },
    },
  };
}

function unauthorizedActor(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired staff token.');
}

/** A target that exists, or a 404. */
async function readTarget(accountId: string): Promise<AccountRecord> {
  const account = await getAccountByUsername(accountId);
  if (!account || account.accountId !== accountId) throw notFound();
  return account;
}

/**
 * Runs one change: the update on the target (conditional on its version), the
 * actor check unless the actor is the target, and the audit event.
 */
async function commit(
  change: Change,
  update: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  },
): Promise<AccountRecord> {
  const { target, actorAccountId, kind, now } = change;
  const self = target.accountId === actorAccountId;
  const nowIso = now.toISOString();

  const items: Record<string, unknown>[] = [
    {
      Update: {
        TableName: tableName('ACCOUNTS'),
        Key: { username: target.username },
        UpdateExpression: `${update.expression}`,
        ConditionExpression: self
          ? 'tokenVersion = :seen AND isActive = :yes'
          : 'tokenVersion = :seen',
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: {
          ...update.values,
          ':seen': target.tokenVersion,
          ':now': nowIso,
          ':one': 1,
          ...(self ? { ':yes': true } : {}),
        },
      },
    },
    accountEventPut(target.accountId, kind, actorAccountId, now),
  ];
  if (!self) items.push(actorCheck(actorAccountId));

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (failedAt(err, 0)) throw conflict(CHANGED_MEANWHILE);
    if (failedAt(err, 2)) throw unauthorizedActor();
    throw err;
  }
  return readTarget(target.accountId);
}

/** Adds an account for a manager to hand over. The new account can log in at once. */
export async function createManagedAccount(
  input: NewManagedAccount,
  actorAccountId: string,
  now: Date = new Date(),
): Promise<AccountRecord> {
  validateNewAccount(input);
  const username = normalizeUsername(input.email);
  // Also keeps the transaction below valid: one item cannot be written and
  // checked in the same transaction.
  if (username === actorAccountId) {
    throw conflict('An account with this email already exists.');
  }

  if (input.role === 'TECHNICIAN') {
    const existing = (await listAccounts()).find(
      (a) => a.role === 'TECHNICIAN' && a.isActive && a.teamId === input.teamId,
    );
    if (existing) {
      throw conflict('That team already has an active technician account.');
    }
  }

  const nowIso = now.toISOString();
  const item = {
    username,
    accountId: username,
    role: input.role,
    ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
    displayName: input.displayName.trim(),
    passwordHash: input.passwordHash,
    isActive: true,
    tokenVersion: 0,
    failedLoginCount: 0,
    passwordChangedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  toAccountRecord(item);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName('ACCOUNTS'),
              Item: item,
              ConditionExpression: 'attribute_not_exists(#username)',
              ExpressionAttributeNames: { '#username': 'username' },
            },
          },
          accountEventPut(username, 'ACCOUNT_CREATED', actorAccountId, now),
          actorCheck(actorAccountId),
        ],
      }),
    );
  } catch (err) {
    if (failedAt(err, 0)) {
      throw conflict('An account with this email already exists.');
    }
    if (failedAt(err, 2)) throw unauthorizedActor();
    throw err;
  }
  return toAccountRecord(item);
}

/**
 * Sets a new password (already hashed). Ends every session of the account,
 * clears its failed-login count and any lockout.
 */
export async function resetPassword(
  accountId: string,
  passwordHash: string,
  actorAccountId: string,
  now: Date = new Date(),
): Promise<AccountRecord> {
  const target = await readTarget(accountId);
  return commit(
    { target, actorAccountId, kind: 'PASSWORD_RESET', now },
    {
      expression:
        'SET passwordHash = :hash, passwordChangedAt = :now, updatedAt = :now, failedLoginCount = :zero ADD tokenVersion :one REMOVE lockedUntil',
      values: { ':hash': passwordHash, ':zero': 0 },
    },
  );
}

/**
 * Disables or enables an account. Disabling ends every session at once; so
 * does enabling, which keeps a token from before the pause from coming back.
 */
export async function setAccountActive(
  accountId: string,
  isActive: boolean,
  actorAccountId: string,
  now: Date = new Date(),
): Promise<AccountRecord> {
  if (!isActive && accountId === actorAccountId) {
    throw conflict('You cannot disable your own account.');
  }
  const target = await readTarget(accountId);
  if (target.isActive === isActive) {
    throw conflict(
      isActive
        ? 'The account is already active.'
        : 'The account is already disabled.',
    );
  }
  return commit(
    {
      target,
      actorAccountId,
      kind: isActive ? 'ACCOUNT_ENABLED' : 'ACCOUNT_DISABLED',
      now,
    },
    {
      expression:
        'SET isActive = :active, updatedAt = :now ADD tokenVersion :one',
      values: { ':active': isActive },
    },
  );
}

/**
 * Removes a manager's authenticator, so the next login sets up a new one.
 * Ends the manager's sessions. Not allowed on yourself (see the header).
 */
export async function resetMfa(
  accountId: string,
  actorAccountId: string,
  now: Date = new Date(),
): Promise<AccountRecord> {
  if (accountId === actorAccountId) {
    throw conflict(
      'You cannot reset your own MFA. Ask another manager to do it.',
    );
  }
  const target = await readTarget(accountId);
  if (target.role !== 'MANAGER') {
    throw conflict('Only manager accounts use MFA.');
  }
  if (target.mfaSecret === undefined && target.mfaPendingSecret === undefined) {
    throw conflict('This manager has no MFA set up.');
  }
  return commit(
    { target, actorAccountId, kind: 'MFA_RESET', now },
    {
      expression:
        'SET updatedAt = :now ADD tokenVersion :one REMOVE mfaSecret, mfaPendingSecret, mfaEnrolledAt, mfaLastStep',
    },
  );
}
