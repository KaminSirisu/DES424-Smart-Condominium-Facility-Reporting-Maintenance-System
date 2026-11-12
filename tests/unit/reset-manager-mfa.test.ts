import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send },
}));

import {
  resetManagerMfa,
  SCRIPT_ACTOR,
} from '../../backend/src/scripts/reset-manager-mfa.js';

const NOW = new Date('2026-11-11T10:00:00.000Z');

describe('reset-manager-mfa script', () => {
  beforeEach(() => {
    send.mockReset();
    vi.stubEnv('ACCOUNTS_TABLE_NAME', 'test-Accounts');
    vi.stubEnv('ACCOUNT_EVENTS_TABLE_NAME', 'test-AccountEvents');
  });

  it('removes the MFA of a manager, ends the sessions and writes an audit event', async () => {
    send.mockResolvedValue({});

    const username = await resetManagerMfa(' Boss@Example.com ', NOW);

    expect(username).toBe('boss@example.com');
    const [update, event] = send.mock.calls[0][0].input.TransactItems;
    expect(update.Update).toEqual({
      TableName: 'test-Accounts',
      Key: { username: 'boss@example.com' },
      UpdateExpression:
        'SET updatedAt = :now ADD tokenVersion :one REMOVE mfaSecret, mfaPendingSecret, mfaEnrolledAt, mfaLastStep',
      ConditionExpression:
        'attribute_exists(#username) AND #role = :manager AND (attribute_exists(mfaSecret) OR attribute_exists(mfaPendingSecret))',
      ExpressionAttributeNames: { '#username': 'username', '#role': 'role' },
      ExpressionAttributeValues: {
        ':now': NOW.toISOString(),
        ':one': 1,
        ':manager': 'MANAGER',
      },
    });
    expect(event.Put.TableName).toBe('test-AccountEvents');
    expect(event.Put.Item).toMatchObject({
      accountId: 'boss@example.com',
      kind: 'MFA_RESET',
      actorAccountId: SCRIPT_ACTOR,
      occurredAt: NOW.toISOString(),
    });
  });

  it('says so when the account is missing, not a manager, or has no MFA', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
    );
    await expect(resetManagerMfa('boss@example.com', NOW)).rejects.toThrow(
      /does not exist, is not a manager, or has no MFA/,
    );
  });

  it('passes other errors on unchanged', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(resetManagerMfa('boss@example.com', NOW)).rejects.toThrow(
      'throttled',
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ValidationError' }, {}],
      }),
    );
    await expect(resetManagerMfa('boss@example.com', NOW)).rejects.toThrow(
      'cancelled',
    );
  });

  it('does not explain an error that only looks like a failed condition', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('odd'), {
        name: 'SomethingElse',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(resetManagerMfa('boss@example.com', NOW)).rejects.toThrow(
      'odd',
    );
  });

  it('refuses a value that is not an email before any database call', async () => {
    await expect(resetManagerMfa('not-an-email', NOW)).rejects.toThrow(
      /valid manager account email/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
