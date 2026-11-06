import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AccountRecord } from '../../backend/src/shared/accounts';

vi.mock('../../backend/src/shared/accounts', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/shared/accounts')
  >()),
  getAccountByUsername: vi.fn(),
  recordFailedLogin: vi.fn(),
  recordSuccessfulLogin: vi.fn(),
}));

vi.mock('../../backend/src/shared/teams', () => ({ getTeamName: vi.fn() }));

import { handler } from '../../backend/src/auth/staff-login';
import {
  getAccountByUsername,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../../backend/src/shared/accounts';
import { verifyStaffToken } from '../../backend/src/shared/staff-token';
import { getTeamName } from '../../backend/src/shared/teams';

const PASSWORD = 'Correct-Horse-Battery-9';
// Cost 4 keeps the tests fast; verifyPassword accepts any bcrypt cost.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const technician: AccountRecord = {
  accountId: 'plumbing@example.com',
  username: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: PASSWORD_HASH,
  isActive: true,
  tokenVersion: 3,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const manager: AccountRecord = {
  ...technician,
  accountId: 'manager@example.com',
  username: 'manager@example.com',
  role: 'MANAGER',
  teamId: undefined,
  displayName: 'Building manager',
  tokenVersion: 0,
};

function event(
  payload: unknown,
  rawBody?: string,
  isBase64Encoded = false,
): APIGatewayProxyEventV2 {
  return {
    headers: {},
    body: rawBody ?? JSON.stringify(payload),
    isBase64Encoded,
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

const login = (email = 'plumbing@example.com', password = PASSWORD) =>
  handler(event({ email, password }));

function bodyOf(result: { body?: string }) {
  return JSON.parse(result.body ?? '{}');
}

const getAccount = vi.mocked(getAccountByUsername);
const failedLogin = vi.mocked(recordFailedLogin);
const successfulLogin = vi.mocked(recordSuccessfulLogin);

describe('POST /auth/staff/login', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('STAFF_JWT_SECRET', 'x'.repeat(40));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getAccount.mockResolvedValue(technician);
    failedLogin.mockResolvedValue({ locked: false });
    successfulLogin.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('a correct login', () => {
    it('returns a 12 hour token and the profile of a technician', async () => {
      const result = await login(' Plumbing@Example.com ');
      const body = bodyOf(result);

      expect(result.statusCode).toBe(200);
      expect(getAccount).toHaveBeenCalledWith(' Plumbing@Example.com ');
      expect(body.expiresInSeconds).toBe(43200);
      expect(body.staff).toEqual({
        id: 'plumbing@example.com',
        name: 'Plumbing team',
        role: 'TECHNICIAN',
        teamId: 'PLUMBING',
      });
      expect(verifyStaffToken(body.accessToken)).toEqual({
        accountId: 'plumbing@example.com',
        role: 'TECHNICIAN',
        teamId: 'PLUMBING',
        tokenVersion: 3,
      });
    });

    it('adds the team name, and a Teams failure does not stop the login', async () => {
      vi.mocked(getTeamName).mockResolvedValue('Plumbing');
      expect(bodyOf(await login()).staff.teamName).toBe('Plumbing');

      vi.mocked(getTeamName).mockRejectedValue(new Error('throttled'));
      const result = await login();
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result).staff).not.toHaveProperty('teamName');
    });

    it('returns a manager without a team', async () => {
      getAccount.mockResolvedValue(manager);

      const body = bodyOf(await login('manager@example.com'));

      expect(body.staff).toEqual({
        id: 'manager@example.com',
        name: 'Building manager',
        role: 'MANAGER',
      });
      expect(verifyStaffToken(body.accessToken)).toEqual({
        accountId: 'manager@example.com',
        role: 'MANAGER',
        tokenVersion: 0,
      });
    });

    it('clears the failure count and tells the browser not to cache the token', async () => {
      const result = await login();

      expect(successfulLogin).toHaveBeenCalledWith(
        'plumbing@example.com',
        expect.any(Date),
      );
      expect(failedLogin).not.toHaveBeenCalled();
      expect(result.headers?.['cache-control']).toBe('no-store');
      expect(result.headers?.['content-type']).toContain('application/json');
    });

    it('never puts the password or its hash in the answer', async () => {
      const result = await login();
      expect(result.body).not.toContain(PASSWORD);
      expect(result.body).not.toContain(PASSWORD_HASH);
      expect(result.body).not.toContain('passwordHash');
    });

    it('accepts a base64 encoded body', async () => {
      const raw = Buffer.from(
        JSON.stringify({ email: 'plumbing@example.com', password: PASSWORD }),
      ).toString('base64');

      const result = await handler(event(undefined, raw, true));

      expect(result.statusCode).toBe(200);
    });
  });

  describe('a login that is refused', () => {
    const GENERIC = 'Incorrect email or password.';

    it('gives 401 and counts a failure for a wrong password', async () => {
      const result = await login('plumbing@example.com', 'Wrong-Password-123');

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error).toEqual({
        code: 'UNAUTHORIZED',
        message: GENERIC,
        requestId: 'req-1',
      });
      expect(failedLogin).toHaveBeenCalledWith(
        'plumbing@example.com',
        expect.any(Date),
      );
      expect(successfulLogin).not.toHaveBeenCalled();
    });

    it('gives the same 401 for an email that has no account, and counts nothing', async () => {
      getAccount.mockResolvedValue(null);

      const result = await login('nobody@example.com');

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(GENERIC);
      expect(failedLogin).not.toHaveBeenCalled();
      expect(successfulLogin).not.toHaveBeenCalled();
    });

    it('gives the same 401 for a disabled account with the right password, without counting it', async () => {
      getAccount.mockResolvedValue({ ...technician, isActive: false });

      const result = await login();

      expect(result.statusCode).toBe(401);
      expect(bodyOf(result).error.message).toBe(GENERIC);
      expect(failedLogin).not.toHaveBeenCalled();
      expect(successfulLogin).not.toHaveBeenCalled();
    });

    it('gives 429 with Retry-After when the account is locked, even for the right password', async () => {
      getAccount.mockResolvedValue({
        ...technician,
        lockedUntil: new Date(Date.now() + 600_500).toISOString(),
      });

      const result = await login();

      expect(result.statusCode).toBe(429);
      expect(bodyOf(result).error.code).toBe('RATE_LIMITED');
      expect(Number(result.headers?.['Retry-After'])).toBeGreaterThanOrEqual(
        600,
      );
      expect(Number(result.headers?.['Retry-After'])).toBeLessThanOrEqual(601);
      expect(failedLogin).not.toHaveBeenCalled();
      expect(successfulLogin).not.toHaveBeenCalled();
    });

    it('lets a login through once the lock has run out', async () => {
      getAccount.mockResolvedValue({
        ...technician,
        lockedUntil: new Date(Date.now() - 1000).toISOString(),
      });

      const result = await login();

      expect(result.statusCode).toBe(200);
    });

    it('answers 429 on the failure that locks the account', async () => {
      failedLogin.mockResolvedValue({
        locked: true,
        lockedUntil: new Date(Date.now() + 900_500).toISOString(),
      });

      const result = await login('plumbing@example.com', 'Wrong-Password-123');

      expect(result.statusCode).toBe(429);
      expect(Number(result.headers?.['Retry-After'])).toBeGreaterThanOrEqual(
        900,
      );
    });
  });

  describe('a bad request', () => {
    const json = JSON.stringify;
    it.each<[string, string]>([
      ['invalid JSON', '{nope'],
      ['a body that is not an object', '[]'],
      [
        'an unknown field',
        json({ email: 'a@b.co', password: 'x', role: 'MANAGER' }),
      ],
      ['no email', json({ password: 'x' })],
      ['an email without @', json({ email: 'plumbing', password: 'x' })],
      ['an email that is not a string', json({ email: 42, password: 'x' })],
      [
        'an email that is too long',
        json({ email: `${'a'.repeat(250)}@b.co`, password: 'x' }),
      ],
      ['no password', json({ email: 'a@b.co' })],
      ['an empty password', json({ email: 'a@b.co', password: '' })],
      [
        'a password that is not a string',
        json({ email: 'a@b.co', password: 12345 }),
      ],
      [
        'a password that is too long',
        json({ email: 'a@b.co', password: 'x'.repeat(129) }),
      ],
    ])('gives 400 for %s', async (_label, rawBody) => {
      const result = await handler(event(undefined, rawBody));

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result).error.code).toBe('BAD_REQUEST');
      expect(getAccount).not.toHaveBeenCalled();
    });

    it('gives 400 when there is no body at all', async () => {
      const result = await handler({
        headers: {},
        requestContext: { requestId: 'req-1', http: { method: 'POST' } },
      } as unknown as APIGatewayProxyEventV2);

      expect(result.statusCode).toBe(400);
    });
  });

  describe('a server problem', () => {
    it('gives 500 without detail when the account record is broken, and logs no password', async () => {
      getAccount.mockRejectedValue(
        new Error('Account record has an invalid role.'),
      );

      const result = await login();

      expect(result.statusCode).toBe(500);
      expect(bodyOf(result).error.code).toBe('INTERNAL_ERROR');
      expect(result.body).not.toContain('invalid role');
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        PASSWORD,
      );
    });

    it('gives 500 when STAFF_JWT_SECRET is not set, and does not count a success', async () => {
      vi.stubEnv('STAFF_JWT_SECRET', '');

      const result = await login();

      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('accessToken');
    });
  });
});
