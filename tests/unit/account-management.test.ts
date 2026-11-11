import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import {
  createManagedAccount,
  listAccounts,
  resetMfa,
  resetPassword,
  setAccountActive,
  toManagedAccount,
  validateNewAccount,
} from '../../backend/src/shared/account-management.js';
import { toAccountRecord } from '../../backend/src/shared/accounts.js';
import { ddb } from '../../backend/src/shared/dynamodb-client.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date('2026-11-11T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const ACTOR = 'boss@example.com';

const base = {
  isActive: true,
  tokenVersion: 4,
  failedLoginCount: 0,
  passwordHash: '$2b$12$hash',
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};
const technician = (team: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  username: `${team.toLowerCase()}@example.com`,
  accountId: `${team.toLowerCase()}@example.com`,
  role: 'TECHNICIAN',
  teamId: team,
  displayName: `${team} team`,
  ...extra,
});
const manager = (name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  username: `${name}@example.com`,
  accountId: `${name}@example.com`,
  role: 'MANAGER',
  displayName: name,
  ...extra,
});
const withMfa = {
  mfaSecret: 'v1.a.b.c',
  mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
  mfaLastStep: 7,
};

function canceled(...codes: (string | undefined)[]): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

interface FakeCommand {
  constructor: { name: string };
  input: { Key: { username: string } } & Record<string, unknown>;
}

/** Answers reads from `items` (by username) and records every command. */
function fakeTable(
  items: Record<string, unknown>[],
  onTransact: (input: Record<string, unknown>) => unknown = () => ({}),
) {
  const stored = new Map(items.map((i) => [i.username as string, i]));
  send.mockImplementation(async (command: FakeCommand) => {
    const name = command.constructor.name;
    if (name === 'GetCommand') {
      return { Item: stored.get(command.input.Key.username) };
    }
    if (name === 'ScanCommand') return { Items: [...stored.values()] };
    if (name === 'TransactWriteCommand') return onTransact(command.input);
    throw new Error(`unexpected ${name}`);
  });
}

type Item = Record<string, Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const transactions = () =>
  send.mock.calls
    .map((c) => c[0])
    .filter((c: FakeCommand) => c.constructor.name === 'TransactWriteCommand')
    .map((c) => c.input.TransactItems as Item[]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACCOUNTS_TABLE_NAME', 'TestAccounts');
  vi.stubEnv('ACCOUNT_EVENTS_TABLE_NAME', 'TestAccountEvents');
});
afterEach(() => vi.unstubAllEnvs());

describe('toManagedAccount', () => {
  it('shows a technician without secrets or MFA state', () => {
    const view = toManagedAccount(toAccountRecord(technician('PLUMBING')), NOW);
    expect(view).toEqual({
      accountId: 'plumbing@example.com',
      email: 'plumbing@example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      displayName: 'PLUMBING team',
      isActive: true,
      passwordChangedAt: base.passwordChangedAt,
      createdAt: base.createdAt,
    });
    expect(JSON.stringify(view)).not.toContain('hash');
  });

  it('shows whether a manager has confirmed MFA, never the secret', () => {
    const without = toManagedAccount(toAccountRecord(manager('a')), NOW);
    const pending = toManagedAccount(
      toAccountRecord(manager('a', { mfaPendingSecret: 'v1.x.y.z' })),
      NOW,
    );
    const confirmed = toManagedAccount(
      toAccountRecord(manager('a', withMfa)),
      NOW,
    );
    expect(without.mfaEnabled).toBe(false);
    expect(pending.mfaEnabled).toBe(false);
    expect(confirmed.mfaEnabled).toBe(true);
    expect(JSON.stringify(confirmed)).not.toContain('v1.');
  });

  it('shows a lockout only while it lasts, and the last login when there is one', () => {
    const locked = toAccountRecord(
      technician('PLUMBING', {
        lockedUntil: '2026-11-11T10:05:00.000Z',
        lastLoginAt: '2026-11-10T00:00:00.000Z',
      }),
    );
    expect(toManagedAccount(locked, NOW)).toMatchObject({
      lockedUntil: '2026-11-11T10:05:00.000Z',
      lastLoginAt: '2026-11-10T00:00:00.000Z',
    });
    const expired = toAccountRecord(
      technician('PLUMBING', { lockedUntil: '2026-11-11T09:59:59.000Z' }),
    );
    expect(toManagedAccount(expired, NOW)).not.toHaveProperty('lockedUntil');
  });
});

describe('listAccounts', () => {
  it('reads every page with strong consistency, managers first, then by email', async () => {
    send
      .mockResolvedValueOnce({
        Items: [technician('PLUMBING'), manager('zed')],
        LastEvaluatedKey: { username: 'zed@example.com' },
      })
      .mockResolvedValueOnce({
        Items: [technician('ELECTRICAL'), manager('amy')],
      });

    const accounts = await listAccounts();

    expect(accounts.map((a) => a.username)).toEqual([
      'amy@example.com',
      'zed@example.com',
      'electrical@example.com',
      'plumbing@example.com',
    ]);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestAccounts',
      ConsistentRead: true,
      ExclusiveStartKey: undefined,
    });
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      username: 'zed@example.com',
    });
  });

  it('answers an empty table with an empty list', async () => {
    send.mockResolvedValue({});
    expect(await listAccounts()).toEqual([]);
  });

  it('does not hide a damaged item', async () => {
    send.mockResolvedValue({ Items: [{ ...manager('a'), role: 'ROOT' }] });
    await expect(listAccounts()).rejects.toThrow(/role/);
  });
});

describe('validateNewAccount', () => {
  const ok = {
    email: 'a@b.co',
    role: 'TECHNICIAN',
    teamId: 'PLUMBING',
    displayName: 'Plumbing',
  };
  it('accepts a technician with a team and a manager without one', () => {
    expect(() => validateNewAccount(ok)).not.toThrow();
    expect(() =>
      validateNewAccount({ ...ok, role: 'MANAGER', teamId: undefined }),
    ).not.toThrow();
  });

  it.each([
    ['email', { email: 'nope' }],
    ['email', { email: 'a@b' }],
    ['email', { email: 5 }],
    ['email', { email: `${'a'.repeat(250)}@b.co` }],
    ['role', { role: 'ADMIN' }],
    ['teamId', { teamId: undefined }],
    ['teamId', { teamId: 'GARDEN' }],
    ['no teamId', { role: 'MANAGER' }],
    ['displayName', { displayName: '   ' }],
    ['displayName', { displayName: 7 }],
    ['displayName', { displayName: 'x'.repeat(101) }],
  ])('rejects a bad %s with a 400', (_what, change) => {
    expect(() => validateNewAccount({ ...ok, ...change })).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'BAD_REQUEST' }),
    );
  });

  it('takes the longest display name', () => {
    expect(() =>
      validateNewAccount({ ...ok, displayName: 'x'.repeat(100) }),
    ).not.toThrow();
  });
});

describe('createManagedAccount', () => {
  const input = {
    email: '  New.Team@Example.com ',
    role: 'TECHNICIAN' as const,
    teamId: 'PLUMBING',
    displayName: '  Plumbing team ',
    passwordHash: '$2b$12$newhash',
  };

  it('writes the account, the audit event and the actor check in one transaction', async () => {
    fakeTable([manager('boss')]);

    const account = await createManagedAccount(input, ACTOR, NOW);

    expect(transactions()).toHaveLength(1);
    const [put, event, check] = transactions()[0];
    expect(put.Put).toMatchObject({
      TableName: 'TestAccounts',
      ConditionExpression: 'attribute_not_exists(#username)',
      ExpressionAttributeNames: { '#username': 'username' },
      Item: {
        username: 'new.team@example.com',
        accountId: 'new.team@example.com',
        role: 'TECHNICIAN',
        teamId: 'PLUMBING',
        displayName: 'Plumbing team',
        passwordHash: '$2b$12$newhash',
        isActive: true,
        tokenVersion: 0,
        failedLoginCount: 0,
        passwordChangedAt: NOW_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });
    expect(event.Put.TableName).toBe('TestAccountEvents');
    expect(event.Put.Item).toMatchObject({
      accountId: 'new.team@example.com',
      kind: 'ACCOUNT_CREATED',
      occurredAt: NOW_ISO,
      actorAccountId: ACTOR,
    });
    expect(event.Put.Item.eventKey).toBe(
      `${NOW_ISO}#${event.Put.Item.eventId}`,
    );
    expect(check.ConditionCheck).toEqual({
      TableName: 'TestAccounts',
      Key: { username: ACTOR },
      ConditionExpression: 'isActive = :yes AND #role = :manager',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':yes': true, ':manager': 'MANAGER' },
    });
    expect(account.username).toBe('new.team@example.com');
    expect(JSON.stringify(event)).not.toContain('newhash');
  });

  it('creates a manager without a team, and does not scan for teams', async () => {
    fakeTable([]);
    const account = await createManagedAccount(
      { ...input, role: 'MANAGER', teamId: undefined },
      ACTOR,
      NOW,
    );
    expect(account.role).toBe('MANAGER');
    expect(account.teamId).toBeUndefined();
    expect(
      send.mock.calls.some((c) => c[0].constructor.name === 'ScanCommand'),
    ).toBe(false);
  });

  it('refuses a second active technician for a team', async () => {
    fakeTable([technician('PLUMBING')]);
    await expect(createManagedAccount(input, ACTOR, NOW)).rejects.toMatchObject(
      { statusCode: 409, code: 'CONFLICT' },
    );
    expect(transactions()).toHaveLength(0);
  });

  it('allows a new technician when the old one of the team is disabled, or another team has one', async () => {
    fakeTable([
      technician('PLUMBING', { isActive: false }),
      technician('ELECTRICAL'),
    ]);
    await expect(
      createManagedAccount(input, ACTOR, NOW),
    ).resolves.toBeDefined();
  });

  it('answers 409 when the email already has an account', async () => {
    fakeTable([], () => {
      throw canceled('ConditionalCheckFailed', undefined, undefined);
    });
    await expect(createManagedAccount(input, ACTOR, NOW)).rejects.toMatchObject(
      { statusCode: 409, message: expect.stringContaining('already exists') },
    );
  });

  it('answers 401 when the acting manager is no longer active', async () => {
    fakeTable([], () => {
      throw canceled(undefined, undefined, 'ConditionalCheckFailed');
    });
    await expect(createManagedAccount(input, ACTOR, NOW)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it('passes other database errors on', async () => {
    fakeTable([], () => {
      throw new Error('boom');
    });
    await expect(createManagedAccount(input, ACTOR, NOW)).rejects.toThrow(
      'boom',
    );
  });

  it('answers 409 for the acting manager own email without a transaction', async () => {
    fakeTable([manager('boss')]);
    await expect(
      createManagedAccount(
        { ...input, email: ' Boss@Example.com' },
        ACTOR,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(transactions()).toHaveLength(0);
  });

  it('rejects a bad input before any database call', async () => {
    await expect(
      createManagedAccount({ ...input, email: 'nope' }, ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  it('sets the hash, ends the sessions and clears the lockout, with an event', async () => {
    const target = technician('PLUMBING', {
      lockedUntil: '2026-11-11T10:05:00.000Z',
      failedLoginCount: 3,
    });
    fakeTable([target]);

    await resetPassword('plumbing@example.com', '$2b$12$fresh', ACTOR, NOW);

    const [update, event, check] = transactions()[0];
    expect(update.Update).toEqual({
      TableName: 'TestAccounts',
      Key: { username: 'plumbing@example.com' },
      UpdateExpression:
        'SET passwordHash = :hash, passwordChangedAt = :now, updatedAt = :now, failedLoginCount = :zero ADD tokenVersion :one REMOVE lockedUntil',
      ConditionExpression: 'tokenVersion = :seen',
      ExpressionAttributeNames: undefined,
      ExpressionAttributeValues: {
        ':hash': '$2b$12$fresh',
        ':zero': 0,
        ':now': NOW_ISO,
        ':one': 1,
        ':seen': 4,
      },
    });
    expect(event.Put.Item).toMatchObject({
      accountId: 'plumbing@example.com',
      kind: 'PASSWORD_RESET',
      actorAccountId: ACTOR,
    });
    expect(JSON.stringify(event)).not.toContain('fresh');
    expect(check.ConditionCheck.Key).toEqual({ username: ACTOR });
  });

  it('on yourself needs no second operation on the item and keeps the active check in the update', async () => {
    fakeTable([manager('boss')]);
    await resetPassword(ACTOR, '$2b$12$fresh', ACTOR, NOW);
    const items = transactions()[0];
    expect(items).toHaveLength(2);
    expect(items[0].Update.ConditionExpression).toBe(
      'tokenVersion = :seen AND isActive = :yes',
    );
    expect(items[0].Update.ExpressionAttributeValues[':yes']).toBe(true);
  });

  it('works on a disabled account', async () => {
    fakeTable([technician('PLUMBING', { isActive: false })]);
    await expect(
      resetPassword('plumbing@example.com', '$2b$12$fresh', ACTOR, NOW),
    ).resolves.toBeDefined();
  });

  it('answers 404 for an unknown account', async () => {
    fakeTable([]);
    await expect(
      resetPassword('nobody@example.com', '$2b$12$fresh', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(transactions()).toHaveLength(0);
  });

  it('answers 409 when the account changed since it was read', async () => {
    fakeTable([technician('PLUMBING')], () => {
      throw canceled('ConditionalCheckFailed', undefined, undefined);
    });
    await expect(
      resetPassword('plumbing@example.com', '$2b$12$fresh', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('answers 401 when the acting manager is no longer active', async () => {
    fakeTable([technician('PLUMBING')], () => {
      throw canceled(undefined, undefined, 'ConditionalCheckFailed');
    });
    await expect(
      resetPassword('plumbing@example.com', '$2b$12$fresh', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('passes other database errors on', async () => {
    fakeTable([technician('PLUMBING')], () => {
      throw canceled(undefined, undefined, 'ValidationError');
    });
    await expect(
      resetPassword('plumbing@example.com', '$2b$12$fresh', ACTOR, NOW),
    ).rejects.toThrow('Transaction cancelled');
  });

  it('answers 409 for a self reset that fails its own condition (disabled or changed)', async () => {
    fakeTable([manager('boss')], () => {
      throw canceled('ConditionalCheckFailed', undefined);
    });
    await expect(
      resetPassword(ACTOR, '$2b$12$fresh', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('setAccountActive', () => {
  it('cannot disable yourself, without touching the database', async () => {
    await expect(
      setAccountActive(ACTOR, false, ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(send).not.toHaveBeenCalled();
  });

  it('disables an account: new version, sessions end, ACCOUNT_DISABLED', async () => {
    fakeTable([technician('PLUMBING')]);
    await setAccountActive('plumbing@example.com', false, ACTOR, NOW);
    const [update, event] = transactions()[0];
    expect(update.Update.UpdateExpression).toBe(
      'SET isActive = :active, updatedAt = :now ADD tokenVersion :one',
    );
    expect(update.Update.ExpressionAttributeValues).toMatchObject({
      ':active': false,
      ':seen': 4,
    });
    expect(event.Put.Item.kind).toBe('ACCOUNT_DISABLED');
  });

  it('enables a disabled account: ACCOUNT_ENABLED', async () => {
    fakeTable([technician('PLUMBING', { isActive: false })]);
    await setAccountActive('plumbing@example.com', true, ACTOR, NOW);
    const [update, event] = transactions()[0];
    expect(update.Update.ExpressionAttributeValues[':active']).toBe(true);
    expect(event.Put.Item.kind).toBe('ACCOUNT_ENABLED');
  });

  it('answers 409 when the account is already in that state', async () => {
    fakeTable([technician('PLUMBING')]);
    await expect(
      setAccountActive('plumbing@example.com', true, ACTOR, NOW),
    ).rejects.toThrow(/already active/);
    fakeTable([technician('PLUMBING', { isActive: false })]);
    await expect(
      setAccountActive('plumbing@example.com', false, ACTOR, NOW),
    ).rejects.toThrow(/already disabled/);
    expect(transactions()).toHaveLength(0);
  });

  it('answers 404 for an unknown account', async () => {
    fakeTable([]);
    await expect(
      setAccountActive('nobody@example.com', false, ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets one manager disable another, and the other cannot finish at the same time', async () => {
    fakeTable([manager('other')], () => {
      throw canceled(undefined, undefined, 'ConditionalCheckFailed');
    });
    await expect(
      setAccountActive('other@example.com', false, ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('resetMfa', () => {
  it('cannot be done on yourself', async () => {
    await expect(resetMfa(ACTOR, ACTOR, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('removes the authenticator and ends the sessions, with MFA_RESET', async () => {
    fakeTable([manager('other', withMfa)]);
    await resetMfa('other@example.com', ACTOR, NOW);
    const [update, event] = transactions()[0];
    expect(update.Update.UpdateExpression).toBe(
      'SET updatedAt = :now ADD tokenVersion :one REMOVE mfaSecret, mfaPendingSecret, mfaEnrolledAt, mfaLastStep',
    );
    expect(event.Put.Item).toMatchObject({
      accountId: 'other@example.com',
      kind: 'MFA_RESET',
      actorAccountId: ACTOR,
    });
  });

  it('also clears an enrolment that was started but not confirmed', async () => {
    fakeTable([manager('other', { mfaPendingSecret: 'v1.a.b.c' })]);
    await expect(
      resetMfa('other@example.com', ACTOR, NOW),
    ).resolves.toBeDefined();
  });

  it('answers 409 for a technician and for a manager without MFA', async () => {
    fakeTable([technician('PLUMBING'), manager('fresh')]);
    await expect(resetMfa('plumbing@example.com', ACTOR, NOW)).rejects.toThrow(
      /Only manager/,
    );
    await expect(resetMfa('fresh@example.com', ACTOR, NOW)).rejects.toThrow(
      /no MFA/,
    );
    expect(transactions()).toHaveLength(0);
  });

  it('treats an item whose accountId differs from its key as not found', async () => {
    fakeTable([manager('other', { ...withMfa, accountId: 'someone-else' })]);
    await expect(
      resetMfa('other@example.com', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(transactions()).toHaveLength(0);
  });

  it('answers 404 for an unknown account', async () => {
    fakeTable([]);
    await expect(
      resetMfa('nobody@example.com', ACTOR, NOW),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
