import { describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/accounts', () => ({
  createAccount: vi.fn(),
}));

import {
  parseSeedArgs,
  seedAccounts,
  type SeedDeps,
} from '../../backend/src/scripts/seed-accounts';

function deps(existing: string[] = []): SeedDeps & {
  created: { username: string; passwordHash: string }[];
} {
  const created: { username: string; passwordHash: string }[] = [];
  let n = 0;
  return {
    created,
    generatePassword: () => `password-${++n}`,
    hashPassword: async (p) => `hash(${p})`,
    createAccount: async (account) => {
      if (existing.includes(account.username)) return 'exists';
      created.push({
        username: account.username,
        passwordHash: account.passwordHash,
      });
      return 'created';
    },
  };
}

describe('seedAccounts', () => {
  const options = {
    managerEmail: 'manager@example.com',
    managerName: 'Juristic manager',
  };

  it('creates only the manager when there is no teams domain', async () => {
    const d = deps();

    const results = await seedAccounts(options, d);

    expect(results).toEqual([
      {
        username: 'manager@example.com',
        role: 'MANAGER',
        status: 'created',
        password: 'password-1',
      },
    ]);
    expect(d.created).toEqual([
      { username: 'manager@example.com', passwordHash: 'hash(password-1)' },
    ]);
  });

  it('also creates one technician account for each of the 5 teams', async () => {
    const results = await seedAccounts(
      { ...options, teamsDomain: 'example.com' },
      deps(),
    );

    expect(results.map((r) => [r.username, r.role, r.teamId])).toEqual([
      ['manager@example.com', 'MANAGER', undefined],
      ['electrical@example.com', 'TECHNICIAN', 'ELECTRICAL'],
      ['plumbing@example.com', 'TECHNICIAN', 'PLUMBING'],
      ['hvac@example.com', 'TECHNICIAN', 'HVAC'],
      ['cleaning-sanitation@example.com', 'TECHNICIAN', 'CLEANING_SANITATION'],
      ['building-equipment@example.com', 'TECHNICIAN', 'BUILDING_EQUIPMENT'],
    ]);
    expect(new Set(results.map((r) => r.password)).size).toBe(6);
  });

  it('stores only the hash, and skips an existing account without a password', async () => {
    const d = deps(['plumbing@example.com']);

    const results = await seedAccounts(
      { ...options, teamsDomain: 'example.com' },
      d,
    );

    const plumbing = results.find((r) => r.teamId === 'PLUMBING');
    expect(plumbing).toEqual({
      username: 'plumbing@example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      status: 'exists',
    });
    expect(d.created).toHaveLength(5);
    expect(d.created.every((c) => c.passwordHash.startsWith('hash('))).toBe(
      true,
    );
  });

  it('passes on an error and stops', async () => {
    const d = deps();
    d.createAccount = vi.fn().mockRejectedValue(new Error('throttled'));
    await expect(seedAccounts(options, d)).rejects.toThrow('throttled');
  });
});

describe('parseSeedArgs', () => {
  it('reads the options and normalizes the emails and the domain', () => {
    expect(
      parseSeedArgs([
        '--manager-email',
        ' Manager@Example.com ',
        '--manager-name',
        ' Juristic manager ',
        '--teams-domain',
        'Example.COM',
      ]),
    ).toEqual({
      managerEmail: 'manager@example.com',
      managerName: 'Juristic manager',
      teamsDomain: 'example.com',
    });
  });

  it('does not need a teams domain', () => {
    expect(
      parseSeedArgs(['--manager-email', 'm@x.co', '--manager-name', 'M']),
    ).toEqual({ managerEmail: 'm@x.co', managerName: 'M' });
  });

  it.each([
    ['nothing', []],
    ['no name', ['--manager-email', 'm@x.co']],
    ['no email', ['--manager-name', 'M']],
    [
      'an unknown option',
      ['--manager-email', 'm@x.co', '--manager-name', 'M', '--x', 'y'],
    ],
    ['a missing value', ['--manager-email', '--manager-name', 'M']],
    [
      'an email without @',
      ['--manager-email', 'manager', '--manager-name', 'M'],
    ],
    [
      'a bad domain',
      [
        '--manager-email',
        'm@x.co',
        '--manager-name',
        'M',
        '--teams-domain',
        'not a domain',
      ],
    ],
    [
      'a domain without a dot',
      [
        '--manager-email',
        'm@x.co',
        '--manager-name',
        'M',
        '--teams-domain',
        'localhost',
      ],
    ],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseSeedArgs(argv)).toThrow();
  });
});
