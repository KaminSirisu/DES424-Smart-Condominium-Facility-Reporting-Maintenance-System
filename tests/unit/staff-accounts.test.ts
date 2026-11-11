import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError } from '../../backend/src/tickets/types';
import type { AccountRecord } from '../../backend/src/shared/accounts';

vi.mock('../../backend/src/shared/staff-auth', () => ({
  requireStaff: vi.fn(),
}));
vi.mock('../../backend/src/shared/account-management', async (original) => ({
  ...(await original<
    typeof import('../../backend/src/shared/account-management')
  >()),
  listAccounts: vi.fn(),
  createManagedAccount: vi.fn(),
  resetPassword: vi.fn(),
  setAccountActive: vi.fn(),
  resetMfa: vi.fn(),
}));

import {
  createHandler,
  listHandler,
  updateHandler,
} from '../../backend/src/accounts/staff-accounts';
import {
  createManagedAccount,
  listAccounts,
  resetMfa,
  resetPassword,
  setAccountActive,
} from '../../backend/src/shared/account-management';
import { verifyPassword } from '../../backend/src/shared/password';
import { requireStaff } from '../../backend/src/shared/staff-auth';
import type { StaffIdentity } from '../../backend/src/shared/staff-token';

const manager: StaffIdentity = {
  accountId: 'boss@example.com',
  role: 'MANAGER',
  tokenVersion: 1,
};
const technician: StaffIdentity = {
  accountId: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 1,
};

const record = (extra: Partial<AccountRecord> = {}): AccountRecord => ({
  accountId: 'plumbing@example.com',
  username: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: '$2b$12$secret-hash-value',
  isActive: true,
  tokenVersion: 2,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

function event(
  payload?: unknown,
  accountId?: string,
  raw?: string,
): APIGatewayProxyEventV2 {
  return {
    headers: { authorization: 'Bearer t' },
    body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload)),
    isBase64Encoded: false,
    pathParameters: accountId === undefined ? undefined : { accountId },
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

const staff = vi.mocked(requireStaff);
const list = vi.mocked(listAccounts);
const create = vi.mocked(createManagedAccount);
const reset = vi.mocked(resetPassword);
const setActive = vi.mocked(setAccountActive);
const resetTotp = vi.mocked(resetMfa);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  staff.mockResolvedValue(manager);
});
afterEach(() => vi.restoreAllMocks());

/** Every handler: manager only, never cached. */
describe.each([
  ['list', () => listHandler(event())],
  [
    'create',
    () =>
      createHandler(
        event({
          email: 'a@b.co',
          role: 'TECHNICIAN',
          teamId: 'PLUMBING',
          displayName: 'x',
        }),
      ),
  ],
  [
    'update',
    () => updateHandler(event({ action: 'RESET_MFA' }, 'plumbing@example.com')),
  ],
])('%s', (_name, call) => {
  it('is refused for a technician with 403 and does nothing', async () => {
    staff.mockResolvedValue(technician);
    const result = await call();
    expect(result.statusCode).toBe(403);
    expect(body(result).error.code).toBe('FORBIDDEN');
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    expect(resetTotp).not.toHaveBeenCalled();
  });

  it('passes on a 401 from the token check', async () => {
    staff.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    expect((await call()).statusCode).toBe(401);
  });

  it('is never cached', async () => {
    list.mockResolvedValue([]);
    create.mockResolvedValue(record());
    reset.mockResolvedValue(record());
    resetTotp.mockResolvedValue(record());
    expect((await call()).headers?.['cache-control']).toBe('no-store');
  });
});

describe('GET /staff-accounts', () => {
  it('lists the accounts without hashes or secrets', async () => {
    list.mockResolvedValue([
      record({
        role: 'MANAGER',
        teamId: undefined,
        accountId: 'boss@example.com',
        username: 'boss@example.com',
        displayName: 'Boss',
        mfaSecret: 'v1.a.b.c',
        mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
      }),
      record(),
    ]);

    const result = await listHandler(event());
    const answer = body(result);

    expect(result.statusCode).toBe(200);
    expect(answer.items).toHaveLength(2);
    expect(answer.items[0]).toMatchObject({
      accountId: 'boss@example.com',
      email: 'boss@example.com',
      role: 'MANAGER',
      mfaEnabled: true,
    });
    expect(answer.items[1]).toMatchObject({
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      isActive: true,
    });
    expect(result.body).not.toContain('secret-hash-value');
    expect(result.body).not.toContain('v1.a.b.c');
    expect(result.body).not.toContain('passwordHash');
  });
});

describe('POST /staff-accounts', () => {
  const input = {
    email: 'New@Example.com',
    role: 'TECHNICIAN',
    teamId: 'PLUMBING',
    displayName: 'Plumbing team',
  };

  it('creates the account with a generated password that is shown once and stored only as a hash', async () => {
    create.mockImplementation(async (account) =>
      record({
        accountId: 'new@example.com',
        username: 'new@example.com',
        passwordHash: account.passwordHash,
      }),
    );

    const result = await createHandler(event(input));
    const answer = body(result);

    expect(result.statusCode).toBe(201);
    expect(answer.account).toMatchObject({
      accountId: 'new@example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
    });
    expect(answer.temporaryPassword).toHaveLength(20);

    const [passed, actor] = create.mock.calls[0];
    expect(actor).toBe('boss@example.com');
    expect(passed).toMatchObject({
      email: 'New@Example.com',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      displayName: 'Plumbing team',
    });
    expect(passed.passwordHash).not.toContain(answer.temporaryPassword);
    expect(
      await verifyPassword(answer.temporaryPassword, passed.passwordHash),
    ).toBe(true);
    expect(result.body).not.toContain(passed.passwordHash);
  });

  it('creates a manager without a team', async () => {
    create.mockResolvedValue(
      record({
        role: 'MANAGER',
        teamId: undefined,
        accountId: 'm@example.com',
        username: 'm@example.com',
      }),
    );
    const result = await createHandler(
      event({ email: 'm@example.com', role: 'MANAGER', displayName: 'M' }),
    );
    expect(result.statusCode).toBe(201);
    expect(create.mock.calls[0][0].teamId).toBeUndefined();
  });

  it.each([
    ['unknown field', { ...input, extra: 1 }],
    ['no email', { ...input, email: undefined }],
    ['bad email', { ...input, email: 'nope' }],
    ['bad role', { ...input, role: 'ADMIN' }],
    ['technician without team', { ...input, teamId: undefined }],
    ['technician with unknown team', { ...input, teamId: 'GARDEN' }],
    ['manager with team', { ...input, role: 'MANAGER' }],
    ['manager with null team', { ...input, role: 'MANAGER', teamId: null }],
    ['empty name', { ...input, displayName: ' ' }],
  ])(
    'answers 400 for %s, before any password work or write',
    async (_n, payload) => {
      const result = await createHandler(event(payload));
      expect(result.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('answers 400 for a body that is missing or not JSON', async () => {
    expect((await createHandler(event())).statusCode).toBe(400);
    expect(
      (await createHandler(event(undefined, undefined, '{nope'))).statusCode,
    ).toBe(400);
  });

  it('passes on a 409 from the repository without the password', async () => {
    create.mockRejectedValue(new ApiError(409, 'CONFLICT', 'exists'));
    const result = await createHandler(event(input));
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('temporaryPassword');
  });

  it('answers 500 without details for an unexpected error', async () => {
    create.mockRejectedValue(new Error('table exploded: secret-detail'));
    const result = await createHandler(event(input));
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret-detail');
  });
});

describe('PATCH /staff-accounts/{accountId}', () => {
  const call = (payload: unknown, id = 'plumbing@example.com') =>
    updateHandler(event(payload, id));

  describe('RESET_PASSWORD', () => {
    it('sets a generated password, shows it once, and stores only its hash', async () => {
      reset.mockImplementation(async (_id, hash) =>
        record({ passwordHash: hash }),
      );

      const result = await call({ action: 'RESET_PASSWORD' });
      const answer = body(result);

      expect(result.statusCode).toBe(200);
      expect(answer.temporaryPassword).toHaveLength(20);
      expect(answer.account.accountId).toBe('plumbing@example.com');
      const [id, hash, actor] = reset.mock.calls[0];
      expect(id).toBe('plumbing@example.com');
      expect(actor).toBe('boss@example.com');
      expect(await verifyPassword(answer.temporaryPassword, hash)).toBe(true);
      expect(result.body).not.toContain(hash);
    });

    it('makes a different password every time', async () => {
      reset.mockResolvedValue(record());
      const a = body(await call({ action: 'RESET_PASSWORD' }));
      const b = body(await call({ action: 'RESET_PASSWORD' }));
      expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
    });

    it('does not take isActive', async () => {
      const result = await call({ action: 'RESET_PASSWORD', isActive: true });
      expect(result.statusCode).toBe(400);
      expect(reset).not.toHaveBeenCalled();
    });
  });

  describe('SET_ACTIVE', () => {
    it('disables and enables, with no password in the answer', async () => {
      setActive.mockResolvedValue(record({ isActive: false }));
      const off = await call({ action: 'SET_ACTIVE', isActive: false });
      expect(setActive).toHaveBeenLastCalledWith(
        'plumbing@example.com',
        false,
        'boss@example.com',
        expect.any(Date),
      );
      expect(body(off).account.isActive).toBe(false);
      expect(off.body).not.toContain('temporaryPassword');

      setActive.mockResolvedValue(record());
      await call({ action: 'SET_ACTIVE', isActive: true });
      expect(setActive).toHaveBeenLastCalledWith(
        'plumbing@example.com',
        true,
        'boss@example.com',
        expect.any(Date),
      );
    });

    it.each([undefined, 'false', 0, null])(
      'needs a real boolean (%j)',
      async (isActive) => {
        const result = await call({ action: 'SET_ACTIVE', isActive });
        expect(result.statusCode).toBe(400);
        expect(setActive).not.toHaveBeenCalled();
      },
    );

    it('passes on the 409 for disabling yourself', async () => {
      setActive.mockRejectedValue(new ApiError(409, 'CONFLICT', 'self'));
      const result = await call(
        { action: 'SET_ACTIVE', isActive: false },
        'boss@example.com',
      );
      expect(result.statusCode).toBe(409);
    });
  });

  describe('RESET_MFA', () => {
    it('removes the authenticator and answers the account', async () => {
      resetTotp.mockResolvedValue(
        record({
          role: 'MANAGER',
          teamId: undefined,
          accountId: 'other@example.com',
          username: 'other@example.com',
        }),
      );
      const result = await call({ action: 'RESET_MFA' }, 'other@example.com');
      expect(result.statusCode).toBe(200);
      expect(resetTotp).toHaveBeenCalledWith(
        'other@example.com',
        'boss@example.com',
        expect.any(Date),
      );
      expect(body(result).account.mfaEnabled).toBe(false);
      expect(result.body).not.toContain('temporaryPassword');
    });

    it('does not take isActive, and passes on a 409', async () => {
      expect(
        (await call({ action: 'RESET_MFA', isActive: true })).statusCode,
      ).toBe(400);
      resetTotp.mockRejectedValue(new ApiError(409, 'CONFLICT', 'no'));
      expect((await call({ action: 'RESET_MFA' })).statusCode).toBe(409);
    });
  });

  describe('the request', () => {
    it.each([
      ['no action', {}],
      ['unknown action', { action: 'DELETE' }],
      ['unknown field', { action: 'RESET_MFA', extra: 1 }],
      ['array', []],
    ])('answers 400 for %s', async (_n, payload) => {
      expect((await call(payload)).statusCode).toBe(400);
    });

    it('answers 400 for a missing or broken accountId and body', async () => {
      expect(
        (await updateHandler(event({ action: 'RESET_MFA' }))).statusCode,
      ).toBe(400);
      expect(
        (await updateHandler(event({ action: 'RESET_MFA' }, '%E0%A4%A')))
          .statusCode,
      ).toBe(400);
      expect(
        (await updateHandler(event({ action: 'RESET_MFA' }, ' '))).statusCode,
      ).toBe(400);
      expect(
        (
          await updateHandler(
            event({ action: 'RESET_MFA' }, `${'a'.repeat(250)}@example.com`),
          )
        ).statusCode,
      ).toBe(400);
      expect((await updateHandler(event(undefined, 'a@b.co'))).statusCode).toBe(
        400,
      );
    });

    it('reads the accountId as an email: percent encoded, upper case or with spaces', async () => {
      resetTotp.mockResolvedValue(record());
      for (const id of [
        'Plumbing%40Example.com',
        'plumbing@example.com',
        ' PLUMBING@example.com ',
      ]) {
        await call({ action: 'RESET_MFA' }, id);
        expect(resetTotp).toHaveBeenLastCalledWith(
          'plumbing@example.com',
          'boss@example.com',
          expect.any(Date),
        );
      }
    });

    it('answers 404 from the repository for an unknown account', async () => {
      reset.mockRejectedValue(
        new ApiError(404, 'NOT_FOUND', 'Account not found.'),
      );
      const result = await call(
        { action: 'RESET_PASSWORD' },
        'nobody@example.com',
      );
      expect(result.statusCode).toBe(404);
    });
  });
});
