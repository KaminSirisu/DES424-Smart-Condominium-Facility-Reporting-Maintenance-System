import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import {
  acceptMfaStep,
  confirmMfaEnrolment,
  storePendingMfaSecret,
} from '../../backend/src/shared/account-mfa.js';
import {
  toAccountRecord,
  type AccountRecord,
} from '../../backend/src/shared/accounts.js';
import { ddb } from '../../backend/src/shared/dynamodb-client.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date('2026-11-11T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const managerItem = {
  username: 'boss@example.com',
  accountId: 'boss@example.com',
  role: 'MANAGER',
  displayName: 'Boss',
  passwordHash: '$2b$12$hash',
  isActive: true,
  tokenVersion: 4,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};
const fresh: AccountRecord = toAccountRecord(managerItem);
const pending: AccountRecord = toAccountRecord({
  ...managerItem,
  mfaPendingSecret: 'v1.p.p.p',
});
const enrolled: AccountRecord = toAccountRecord({
  ...managerItem,
  mfaSecret: 'v1.s.s.s',
  mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
  mfaLastStep: 100,
});

const conditionFailed = () =>
  Object.assign(new Error('failed'), {
    name: 'ConditionalCheckFailedException',
  });
const transactionFailed = (code: string | undefined) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: code }, {}],
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACCOUNTS_TABLE_NAME', 'TestAccounts');
  vi.stubEnv('ACCOUNT_EVENTS_TABLE_NAME', 'TestAccountEvents');
});
afterEach(() => vi.unstubAllEnvs());

describe('storePendingMfaSecret', () => {
  it('stores the pending secret, only while the account is unchanged, active and not enrolled', async () => {
    send.mockResolvedValue({});

    await expect(storePendingMfaSecret(fresh, 'v1.n.n.n', NOW)).resolves.toBe(
      true,
    );

    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'boss@example.com' },
      UpdateExpression: 'SET mfaPendingSecret = :secret, updatedAt = :now',
      ConditionExpression:
        'tokenVersion = :seen AND isActive = :yes AND attribute_not_exists(mfaSecret)',
      ExpressionAttributeValues: {
        ':secret': 'v1.n.n.n',
        ':now': NOW_ISO,
        ':seen': 4,
        ':yes': true,
      },
    });
  });

  it('answers false when the condition fails and passes other errors on', async () => {
    send.mockRejectedValueOnce(conditionFailed());
    await expect(storePendingMfaSecret(fresh, 'v1.n.n.n', NOW)).resolves.toBe(
      false,
    );
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(storePendingMfaSecret(fresh, 'v1.n.n.n', NOW)).rejects.toThrow(
      'boom',
    );
  });
});

describe('confirmMfaEnrolment', () => {
  it('moves the pending secret to the confirmed one, raises the version and writes an event', async () => {
    send.mockResolvedValue({});

    await expect(confirmMfaEnrolment(pending, 555, NOW)).resolves.toBe(5);

    const [update, event] = send.mock.calls[0][0].input.TransactItems;
    expect(update.Update).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'boss@example.com' },
      UpdateExpression:
        'SET mfaSecret = :secret, mfaEnrolledAt = :now, mfaLastStep = :step, updatedAt = :now ADD tokenVersion :one REMOVE mfaPendingSecret',
      ConditionExpression:
        'tokenVersion = :seen AND isActive = :yes AND mfaPendingSecret = :secret AND attribute_not_exists(mfaSecret)',
      ExpressionAttributeValues: {
        ':secret': 'v1.p.p.p',
        ':now': NOW_ISO,
        ':step': 555,
        ':one': 1,
        ':seen': 4,
        ':yes': true,
      },
    });
    expect(event.Put.TableName).toBe('TestAccountEvents');
    expect(event.Put.Item).toMatchObject({
      accountId: 'boss@example.com',
      kind: 'MFA_ENROLLED',
      actorAccountId: 'boss@example.com',
      occurredAt: NOW_ISO,
    });
  });

  it('answers null when the condition fails and passes other errors on', async () => {
    send.mockRejectedValueOnce(transactionFailed('ConditionalCheckFailed'));
    await expect(confirmMfaEnrolment(pending, 555, NOW)).resolves.toBeNull();
    send.mockRejectedValueOnce(transactionFailed('ValidationError'));
    await expect(confirmMfaEnrolment(pending, 555, NOW)).rejects.toThrow(
      'cancelled',
    );
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(confirmMfaEnrolment(pending, 555, NOW)).rejects.toThrow(
      'boom',
    );
  });

  it('refuses an account that has no pending secret', async () => {
    await expect(confirmMfaEnrolment(fresh, 555, NOW)).rejects.toThrow(
      /no pending/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('acceptMfaStep', () => {
  it('records the step only if it is newer than the last one used', async () => {
    send.mockResolvedValue({});

    await expect(acceptMfaStep(enrolled, 101)).resolves.toBe(true);

    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'boss@example.com' },
      UpdateExpression: 'SET mfaLastStep = :step',
      ConditionExpression:
        'tokenVersion = :seen AND isActive = :yes AND attribute_exists(mfaSecret) AND (attribute_not_exists(mfaLastStep) OR mfaLastStep < :step)',
      ExpressionAttributeValues: { ':step': 101, ':seen': 4, ':yes': true },
    });
  });

  it('answers false when the step was used or the account changed, and passes other errors on', async () => {
    send.mockRejectedValueOnce(conditionFailed());
    await expect(acceptMfaStep(enrolled, 100)).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(acceptMfaStep(enrolled, 101)).rejects.toThrow('boom');
  });
});
