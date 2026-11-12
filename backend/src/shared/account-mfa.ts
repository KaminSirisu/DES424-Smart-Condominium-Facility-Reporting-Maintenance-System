import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { accountEventPut } from './account-management.js';
import type { AccountRecord } from './accounts.js';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';

/**
 * How a manager's TOTP setup and codes are stored (SR-09). The secrets in these
 * calls are already encrypted (shared/mfa-secret.ts). Every write is
 * conditional on the account being as the caller read it (`tokenVersion`, still
 * active), so a password reset, a disable or an MFA reset by another manager in
 * between wins and the login step fails.
 *
 * Each function answers whether its condition held; the handler decides what
 * to tell the caller.
 */

function isConditionalCheckFailure(err: unknown): boolean {
  const e = err as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  return (
    e?.name === 'ConditionalCheckFailedException' ||
    (e?.name === 'TransactionCanceledException' &&
      e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed')
  );
}

/**
 * Keeps a freshly made secret as the pending one, replacing an earlier pending
 * secret. False when the account already has a confirmed secret or changed.
 */
export async function storePendingMfaSecret(
  account: AccountRecord,
  encryptedSecret: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName('ACCOUNTS'),
        Key: { username: account.username },
        UpdateExpression: 'SET mfaPendingSecret = :secret, updatedAt = :now',
        ConditionExpression:
          'tokenVersion = :seen AND isActive = :yes AND attribute_not_exists(mfaSecret)',
        ExpressionAttributeValues: {
          ':secret': encryptedSecret,
          ':now': now.toISOString(),
          ':seen': account.tokenVersion,
          ':yes': true,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailure(err)) return false;
    throw err;
  }
}

/**
 * Turns the pending secret into the confirmed one after its first correct
 * code, records `step` as used, and raises `tokenVersion` (so the login step
 * that led here cannot be repeated and sessions from before MFA end). Returns
 * the new `tokenVersion`, or null when the account changed or has no pending
 * secret equal to the one that was checked.
 */
export async function confirmMfaEnrolment(
  account: AccountRecord,
  step: number,
  now: Date = new Date(),
): Promise<number | null> {
  if (account.mfaPendingSecret === undefined) {
    throw new Error('The account has no pending MFA secret.');
  }
  const nowIso = now.toISOString();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName('ACCOUNTS'),
              Key: { username: account.username },
              UpdateExpression:
                'SET mfaSecret = :secret, mfaEnrolledAt = :now, mfaLastStep = :step, updatedAt = :now ADD tokenVersion :one REMOVE mfaPendingSecret',
              ConditionExpression:
                'tokenVersion = :seen AND isActive = :yes AND mfaPendingSecret = :secret AND attribute_not_exists(mfaSecret)',
              ExpressionAttributeValues: {
                ':secret': account.mfaPendingSecret,
                ':now': nowIso,
                ':step': step,
                ':one': 1,
                ':seen': account.tokenVersion,
                ':yes': true,
              },
            },
          },
          accountEventPut(
            account.accountId,
            'MFA_ENROLLED',
            account.accountId,
            now,
          ),
        ],
      }),
    );
    return account.tokenVersion + 1;
  } catch (err) {
    if (isConditionalCheckFailure(err)) return null;
    throw err;
  }
}

/**
 * Records `step` as the last accepted one. False when that step, or a later
 * one, was already used (the same code twice), or the account changed.
 */
export async function acceptMfaStep(
  account: AccountRecord,
  step: number,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName('ACCOUNTS'),
        Key: { username: account.username },
        UpdateExpression: 'SET mfaLastStep = :step',
        ConditionExpression:
          'tokenVersion = :seen AND isActive = :yes AND attribute_exists(mfaSecret) AND (attribute_not_exists(mfaLastStep) OR mfaLastStep < :step)',
        ExpressionAttributeValues: {
          ':step': step,
          ':seen': account.tokenVersion,
          ':yes': true,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailure(err)) return false;
    throw err;
  }
}
