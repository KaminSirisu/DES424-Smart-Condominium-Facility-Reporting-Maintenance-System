import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AccountRecord } from '../../backend/src/shared/accounts';

vi.mock('../../backend/src/shared/accounts', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/accounts')
  >()),
  getAccountByUsername: vi.fn(),
}));

import { handler } from '../../backend/src/auth/staff-me';
import { getAccountByUsername } from '../../backend/src/shared/accounts';
import { signStaffToken } from '../../backend/src/shared/staff-token';

const account: AccountRecord = {
  accountId: 'plumbing@example.com',
  username: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: '$2b$12$secret-hash',
  isActive: true,
  tokenVersion: 3,
  failedLoginCount: 2,
  lockedUntil: '2026-11-06T10:15:00.000Z',
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const token = () =>
  signStaffToken({
    accountId: 'plumbing@example.com',
    role: 'TECHNICIAN',
    teamId: 'PLUMBING',
    tokenVersion: 3,
  });

function event(authorization?: string): APIGatewayProxyEventV2 {
  return {
    headers: authorization ? { authorization } : {},
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

const getAccount = vi.mocked(getAccountByUsername);

describe('GET /auth/staff/me', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('STAFF_JWT_SECRET', 'x'.repeat(40));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getAccount.mockResolvedValue(account);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the profile of the current account and nothing else', async () => {
    const result = await handler(event(`Bearer ${token()}`));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '')).toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
    });
    expect(result.body).not.toContain('secret-hash');
    expect(result.body).not.toContain('lockedUntil');
  });

  it('shows a display name changed after the token was issued', async () => {
    getAccount.mockResolvedValue({ ...account, displayName: 'Plumbers' });

    const result = await handler(event(`Bearer ${token()}`));

    expect(JSON.parse(result.body ?? '').name).toBe('Plumbers');
  });

  it.each([
    ['no token', undefined],
    ['a bad token', 'Bearer a.b.c'],
  ])('gives 401 for %s', async (_label, authorization) => {
    const result = await handler(event(authorization));

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body ?? '').error.code).toBe('UNAUTHORIZED');
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('gives 401 for a disabled account', async () => {
    getAccount.mockResolvedValue({ ...account, isActive: false });

    const result = await handler(event(`Bearer ${token()}`));

    expect(result.statusCode).toBe(401);
  });

  it('gives 401 once the token version has been raised', async () => {
    getAccount.mockResolvedValue({ ...account, tokenVersion: 4 });

    const result = await handler(event(`Bearer ${token()}`));

    expect(result.statusCode).toBe(401);
  });

  it('gives 500 without detail when the Accounts table fails', async () => {
    getAccount.mockRejectedValue(new Error('throttled'));

    const result = await handler(event(`Bearer ${token()}`));

    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('throttled');
  });
});
