import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import {
  getAccountByUsername,
  isLocked,
  LOCK_MINUTES,
  normalizeUsername,
  recordFailedLogin,
  recordSuccessfulLogin,
  toStaffProfile,
  type AccountRecord,
} from '../../backend/src/shared/accounts.js';
import { ddb } from '../../backend/src/shared/dynamodb-client.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date('2026-11-06T10:00:00.000Z');

const TECHNICIAN_ITEM = {
  username: 'plumbing@example.com',
  accountId: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: '$2b$12$hash',
  isActive: true,
  tokenVersion: 3,
  failedLoginCount: 2,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};

function conditionalCheckFailed(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

describe('normalizeUsername', () => {
  it('trims and lower-cases', () => {
    expect(normalizeUsername('  Plumbing@Example.COM ')).toBe(
      'plumbing@example.com',
    );
  });
});

describe('getAccountByUsername', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ACCOUNTS_TABLE_NAME', 'TestAccounts');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reads the normalized username with a strongly consistent read', async () => {
    send.mockResolvedValue({ Item: TECHNICIAN_ITEM });

    const account = await getAccountByUsername('  Plumbing@Example.com ');

    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'plumbing@example.com' },
      ConsistentRead: true,
    });
    expect(account).toMatchObject({
      accountId: 'plumbing@example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      tokenVersion: 3,
      failedLoginCount: 2,
      isActive: true,
    });
    expect(account?.lockedUntil).toBeUndefined();
  });

  it('returns null when there is no account', async () => {
    send.mockResolvedValue({});
    await expect(getAccountByUsername('nobody')).resolves.toBeNull();
  });

  it('returns null for an empty username without calling DynamoDB', async () => {
    await expect(getAccountByUsername('   ')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('reads a manager, who has no team', async () => {
    const item: Record<string, unknown> = {
      ...TECHNICIAN_ITEM,
      role: 'MANAGER',
      failedLoginCount: undefined,
    };
    delete item.teamId;
    send.mockResolvedValue({ Item: item });

    const account = await getAccountByUsername('plumbing@example.com');

    expect(account?.role).toBe('MANAGER');
    expect(account).not.toHaveProperty('teamId');
    expect(account?.failedLoginCount).toBe(0);
  });

  it.each([
    ['an unknown role', { role: 'ADMIN' }],
    ['a technician without a team', { teamId: undefined }],
    ['a technician with an unknown team', { teamId: 'NOT_A_TEAM' }],
    ['a manager that has a team', { role: 'MANAGER' }],
    ['isActive that is not a boolean', { isActive: 'yes' }],
    ['a missing password hash', { passwordHash: undefined }],
    ['a negative token version', { tokenVersion: -1 }],
    ['a fractional failed login count', { failedLoginCount: 1.5 }],
    ['an empty lockedUntil', { lockedUntil: '' }],
  ])('throws for %s', async (_label, override) => {
    send.mockResolvedValue({ Item: { ...TECHNICIAN_ITEM, ...override } });
    await expect(getAccountByUsername('plumbing@example.com')).rejects.toThrow(
      /Account record has an invalid/,
    );
  });

  it('does not put the password hash in the error', async () => {
    send.mockResolvedValue({ Item: { ...TECHNICIAN_ITEM, role: 'ADMIN' } });
    await expect(
      getAccountByUsername('plumbing@example.com'),
    ).rejects.not.toThrow(/\$2b\$/);
  });
});

describe('isLocked', () => {
  const account = (lockedUntil?: string) =>
    ({ lockedUntil }) as unknown as AccountRecord;

  it('is locked while lockedUntil is in the future', () => {
    expect(isLocked(account('2026-11-06T10:00:01.000Z'), NOW)).toBe(true);
  });

  it('is not locked at or after lockedUntil, or when it is not set', () => {
    expect(isLocked(account('2026-11-06T10:00:00.000Z'), NOW)).toBe(false);
    expect(isLocked(account('2026-11-06T09:00:00.000Z'), NOW)).toBe(false);
    expect(isLocked(account(undefined), NOW)).toBe(false);
  });
});

describe('recordFailedLogin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ACCOUNTS_TABLE_NAME', 'TestAccounts');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts the failure with one conditional update below the limit', async () => {
    send.mockResolvedValue({});

    const result = await recordFailedLogin(' Plumbing@Example.com ', NOW);

    expect(result).toEqual({ locked: false });
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0].input;
    expect(input.TableName).toBe('TestAccounts');
    expect(input.Key).toEqual({ username: 'plumbing@example.com' });
    expect(input.UpdateExpression).toBe(
      'SET updatedAt = :now ADD failedLoginCount :one',
    );
    expect(input.ConditionExpression).toContain('attribute_exists(#username)');
    expect(input.ExpressionAttributeValues).toEqual({
      ':now': NOW.toISOString(),
      ':one': 1,
      ':beforeLock': 4,
    });
  });

  it('locks the account for 15 minutes on the fifth failure and restarts the count', async () => {
    send
      .mockRejectedValueOnce(conditionalCheckFailed())
      .mockResolvedValueOnce({});

    const result = await recordFailedLogin('plumbing@example.com', NOW);

    expect(LOCK_MINUTES).toBe(15);
    expect(result).toEqual({
      locked: true,
      lockedUntil: '2026-11-06T10:15:00.000Z',
    });
    const input = send.mock.calls[1][0].input;
    expect(input.UpdateExpression).toBe(
      'SET lockedUntil = :until, failedLoginCount = :zero, updatedAt = :now',
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ':until': '2026-11-06T10:15:00.000Z',
      ':zero': 0,
      ':now': NOW.toISOString(),
    });
  });

  it('does nothing for an account that does not exist', async () => {
    send
      .mockRejectedValueOnce(conditionalCheckFailed())
      .mockRejectedValueOnce(conditionalCheckFailed());

    await expect(recordFailedLogin('nobody', NOW)).resolves.toEqual({
      locked: false,
    });
  });

  it('passes on any other error', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(
      recordFailedLogin('plumbing@example.com', NOW),
    ).rejects.toThrow('throttled');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('passes on an error from the lock update', async () => {
    send
      .mockRejectedValueOnce(conditionalCheckFailed())
      .mockRejectedValueOnce(new Error('throttled'));
    await expect(
      recordFailedLogin('plumbing@example.com', NOW),
    ).rejects.toThrow('throttled');
  });
});

describe('recordSuccessfulLogin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ACCOUNTS_TABLE_NAME', 'TestAccounts');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('clears the failures and the lock and stores the login time', async () => {
    send.mockResolvedValue({});

    await recordSuccessfulLogin('Plumbing@Example.com', NOW);

    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'plumbing@example.com' },
      UpdateExpression:
        'SET lastLoginAt = :now, updatedAt = :now, failedLoginCount = :zero REMOVE lockedUntil',
      ConditionExpression: 'attribute_exists(#username)',
      ExpressionAttributeNames: { '#username': 'username' },
      ExpressionAttributeValues: { ':now': NOW.toISOString(), ':zero': 0 },
    });
  });
});

describe('toStaffProfile', () => {
  const account = (overrides: Partial<AccountRecord>) =>
    ({
      ...TECHNICIAN_ITEM,
      ...overrides,
    }) as unknown as AccountRecord;

  it('shows the id, name, role and team of a technician', () => {
    expect(toStaffProfile(account({}))).toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
    });
  });

  it('leaves the team out for a manager and shows no secret', () => {
    const profile = toStaffProfile(
      account({ role: 'MANAGER', teamId: undefined }),
    );

    expect(profile).toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'MANAGER',
    });
    expect(profile).not.toHaveProperty('teamId');
    expect(JSON.stringify(profile)).not.toContain('hash');
  });
});
