import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../../backend/src/shared/accounts';

vi.mock('../../backend/src/shared/accounts', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/accounts')
  >()),
  getAccountByUsername: vi.fn(),
}));

import { getAccountByUsername } from '../../backend/src/shared/accounts';
import {
  requireStaff,
  requireStaffAccount,
} from '../../backend/src/shared/staff-auth';
import {
  signStaffToken,
  type StaffIdentity,
} from '../../backend/src/shared/staff-token';

const NOW = new Date('2026-11-06T10:00:00.000Z');

const technicianAccount: AccountRecord = {
  accountId: 'plumbing@example.com',
  username: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: '$2b$12$hash',
  isActive: true,
  tokenVersion: 3,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const technicianToken: StaffIdentity = {
  accountId: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 3,
};

const bearer = (identity: StaffIdentity) =>
  `Bearer ${signStaffToken(identity, NOW)}`;

const getAccount = vi.mocked(getAccountByUsername);

async function statusOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? err;
  }
}

describe('requireStaffAccount and requireStaff', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('STAFF_JWT_SECRET', 'x'.repeat(40));
    getAccount.mockResolvedValue(technicianAccount);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the account for a valid token', async () => {
    const account = await requireStaffAccount(bearer(technicianToken), NOW);

    expect(account).toBe(technicianAccount);
    expect(getAccount).toHaveBeenCalledWith('plumbing@example.com');
  });

  it('returns the identity of the current account', async () => {
    await expect(requireStaff(bearer(technicianToken), NOW)).resolves.toEqual({
      accountId: 'plumbing@example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      tokenVersion: 3,
    });
  });

  it('has no team for a manager', async () => {
    getAccount.mockResolvedValue({
      ...technicianAccount,
      accountId: 'manager@example.com',
      username: 'manager@example.com',
      role: 'MANAGER',
      teamId: undefined,
      mfaSecret: 'v1.a.b.c',
      mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
    });

    const identity = await requireStaff(
      bearer({
        accountId: 'manager@example.com',
        role: 'MANAGER',
        tokenVersion: 3,
      }),
      NOW,
    );

    expect(identity).toEqual({
      accountId: 'manager@example.com',
      role: 'MANAGER',
      tokenVersion: 3,
    });
    expect(identity).not.toHaveProperty('teamId');
  });

  describe('manager MFA', () => {
    const managerAccount: AccountRecord = {
      ...technicianAccount,
      accountId: 'manager@example.com',
      username: 'manager@example.com',
      role: 'MANAGER',
      teamId: undefined,
    };
    const managerToken = () =>
      bearer({
        accountId: 'manager@example.com',
        role: 'MANAGER',
        tokenVersion: 3,
      });

    it('refuses a manager who has not set up MFA, even with a valid token', async () => {
      getAccount.mockResolvedValue(managerAccount);
      expect(await statusOf(requireStaff(managerToken(), NOW))).toBe(401);
      // A secret that is only pending does not count.
      getAccount.mockResolvedValue({
        ...managerAccount,
        mfaPendingSecret: 'v1.a.b.c',
      });
      expect(await statusOf(requireStaff(managerToken(), NOW))).toBe(401);
    });

    it('lets a manager with MFA in', async () => {
      getAccount.mockResolvedValue({
        ...managerAccount,
        mfaSecret: 'v1.a.b.c',
        mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
      });
      expect(await statusOf(requireStaff(managerToken(), NOW))).toBe(
        'resolved',
      );
    });

    it('lets a manager without MFA in only while MFA is switched off', async () => {
      vi.stubEnv('MANAGER_MFA_REQUIRED', 'false');
      getAccount.mockResolvedValue(managerAccount);
      expect(await statusOf(requireStaff(managerToken(), NOW))).toBe(
        'resolved',
      );
    });

    it('never asks a technician for MFA', async () => {
      expect(await statusOf(requireStaff(bearer(technicianToken), NOW))).toBe(
        'resolved',
      );
    });
  });

  it.each([
    ['the account does not exist', () => getAccount.mockResolvedValue(null)],
    [
      'the account is disabled',
      () =>
        getAccount.mockResolvedValue({ ...technicianAccount, isActive: false }),
    ],
    [
      'the token version is old (password reset)',
      () =>
        getAccount.mockResolvedValue({
          ...technicianAccount,
          tokenVersion: 4,
        }),
    ],
    [
      'the token version is newer than the account',
      () =>
        getAccount.mockResolvedValue({
          ...technicianAccount,
          tokenVersion: 2,
        }),
    ],
    [
      'the role changed',
      () =>
        getAccount.mockResolvedValue({
          ...technicianAccount,
          role: 'MANAGER',
          teamId: undefined,
        }),
    ],
    [
      'the team changed',
      () =>
        getAccount.mockResolvedValue({
          ...technicianAccount,
          teamId: 'ELECTRICAL',
        }),
    ],
    [
      'the stored accountId is not the one in the token',
      () =>
        getAccount.mockResolvedValue({
          ...technicianAccount,
          accountId: 'someone-else',
        }),
    ],
  ])('gives 401 when %s', async (_label, arrange) => {
    arrange();

    expect(await statusOf(requireStaff(bearer(technicianToken), NOW))).toBe(
      401,
    );
    expect(
      await statusOf(requireStaffAccount(bearer(technicianToken), NOW)),
    ).toBe(401);
  });

  it('uses the same message for a disabled account as for a bad token', async () => {
    getAccount.mockResolvedValue({ ...technicianAccount, isActive: false });
    const disabled = await requireStaff(bearer(technicianToken), NOW).catch(
      (err: Error) => err.message,
    );
    const badToken = await requireStaff('Bearer a.b.c', NOW).catch(
      (err: Error) => err.message,
    );

    expect(disabled).toBe('Invalid or expired staff token.');
    expect(disabled).toBe(badToken);
  });

  it('does not read the Accounts table for a missing or bad token', async () => {
    expect(await statusOf(requireStaff(undefined, NOW))).toBe(401);
    expect(await statusOf(requireStaff('Bearer a.b.c', NOW))).toBe(401);
    expect(
      await statusOf(
        requireStaff(
          bearer(technicianToken),
          new Date(NOW.getTime() + 13 * 3600 * 1000),
        ),
      ),
    ).toBe(401);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('passes on a failure to read the Accounts table', async () => {
    getAccount.mockRejectedValue(new Error('throttled'));

    await expect(requireStaff(bearer(technicianToken), NOW)).rejects.toThrow(
      'throttled',
    );
  });
});
