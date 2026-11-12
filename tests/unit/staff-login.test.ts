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
vi.mock('../../backend/src/shared/rate-limit', () => ({
  consumeLoginIpQuota: vi.fn(),
}));

import { handler } from '../../backend/src/auth/staff-login';
import {
  getAccountByUsername,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../../backend/src/shared/accounts';
import { consumeLoginIpQuota } from '../../backend/src/shared/rate-limit';
import { verifyMfaChallenge } from '../../backend/src/shared/mfa-challenge';
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
    vi.mocked(consumeLoginIpQuota).mockResolvedValue({ allowed: true });
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

    it('returns a manager without a team while MFA is switched off', async () => {
      vi.stubEnv('MANAGER_MFA_REQUIRED', 'false');
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

  describe('a manager login (MFA required)', () => {
    const enrolled: AccountRecord = {
      ...manager,
      mfaSecret: 'v1.a.b.c',
      mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
    };

    it('answers a challenge, not a session, and says whether MFA is set up', async () => {
      getAccount.mockResolvedValue(manager);
      const first = await login('manager@example.com');
      const firstBody = bodyOf(first);
      expect(first.statusCode).toBe(200);
      expect(firstBody).toEqual({
        mfaRequired: true,
        mfaEnrolled: false,
        challengeToken: expect.any(String),
        expiresInSeconds: 300,
      });

      getAccount.mockResolvedValue(enrolled);
      expect(bodyOf(await login('manager@example.com')).mfaEnrolled).toBe(true);
    });

    it('gives a challenge for this account and version that is not a staff token', async () => {
      getAccount.mockResolvedValue({ ...enrolled, tokenVersion: 7 });
      const body = bodyOf(await login('manager@example.com'));

      expect(verifyMfaChallenge(body.challengeToken)).toEqual({
        accountId: 'manager@example.com',
        tokenVersion: 7,
      });
      expect(() => verifyStaffToken(body.challengeToken)).toThrow();
      expect(body).not.toHaveProperty('accessToken');
      expect(body).not.toHaveProperty('staff');
    });

    it('does not clear the failure count yet, and is not cached', async () => {
      getAccount.mockResolvedValue(enrolled);
      const result = await login('manager@example.com');

      expect(successfulLogin).not.toHaveBeenCalled();
      expect(failedLogin).not.toHaveBeenCalled();
      expect(result.headers?.['cache-control']).toBe('no-store');
    });

    it('still counts a wrong password and refuses a locked or disabled manager', async () => {
      getAccount.mockResolvedValue(enrolled);
      expect(
        (await login('manager@example.com', 'nope-nope-nope')).statusCode,
      ).toBe(401);
      expect(failedLogin).toHaveBeenCalledTimes(1);

      getAccount.mockResolvedValue({
        ...enrolled,
        lockedUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await login('manager@example.com')).statusCode).toBe(429);

      getAccount.mockResolvedValue({ ...enrolled, isActive: false });
      expect((await login('manager@example.com')).statusCode).toBe(401);
    });

    it('does not change a technician login', async () => {
      const body = bodyOf(await login());
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body).not.toHaveProperty('mfaRequired');
      expect(successfulLogin).toHaveBeenCalled();
    });
  });

  describe('the limit per address (SR-09)', () => {
    const fromIp = (ip: string | undefined, raw?: string) => {
      const base = raw
        ? event(undefined, raw)
        : event({ email: 'plumbing@example.com', password: PASSWORD });
      (base.requestContext as { http: Record<string, unknown> }).http = {
        method: 'POST',
        ...(ip ? { sourceIp: ip } : {}),
      };
      return handler(base);
    };

    it('counts the attempt for the address API Gateway saw, and lets it through', async () => {
      const result = await fromIp('203.0.113.7');

      expect(result.statusCode).toBe(200);
      expect(consumeLoginIpQuota).toHaveBeenCalledOnce();
      expect(consumeLoginIpQuota).toHaveBeenCalledWith(
        '203.0.113.7',
        expect.any(Date),
      );
    });

    it('answers 429 with Retry-After once the address is out of attempts, before anything else is looked at', async () => {
      vi.mocked(consumeLoginIpQuota).mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 421,
      });

      const result = await fromIp('203.0.113.7');

      expect(result.statusCode).toBe(429);
      expect(result.headers?.['Retry-After']).toBe('421');
      expect(bodyOf(result).error).toMatchObject({
        code: 'RATE_LIMITED',
        requestId: 'req-1',
      });
      expect(getAccount).not.toHaveBeenCalled();
      expect(failedLogin).not.toHaveBeenCalled();
      expect(successfulLogin).not.toHaveBeenCalled();
    });

    it('counts an attempt whose body cannot be read, and a wrong password', async () => {
      expect((await fromIp('203.0.113.7', '{nope')).statusCode).toBe(400);
      expect(consumeLoginIpQuota).toHaveBeenCalledTimes(1);

      getAccount.mockResolvedValue(technician);
      const wrong = event({
        email: 'plumbing@example.com',
        password: 'x'.repeat(14),
      });
      (wrong.requestContext as { http: Record<string, unknown> }).http = {
        method: 'POST',
        sourceIp: '203.0.113.7',
      };
      expect((await handler(wrong)).statusCode).toBe(401);
      expect(consumeLoginIpQuota).toHaveBeenCalledTimes(2);
    });

    it('counts nothing when the event has no address', async () => {
      const result = await fromIp(undefined);
      expect(result.statusCode).toBe(200);
      expect(consumeLoginIpQuota).not.toHaveBeenCalled();
    });

    it('answers 500, and never lets the login through, when the counter cannot be written', async () => {
      vi.mocked(consumeLoginIpQuota).mockRejectedValue(new Error('throttled'));
      const result = await fromIp('203.0.113.7');
      expect(result.statusCode).toBe(500);
      expect(getAccount).not.toHaveBeenCalled();
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
