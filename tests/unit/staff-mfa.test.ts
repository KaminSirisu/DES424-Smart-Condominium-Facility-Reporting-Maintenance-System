import { randomBytes } from 'node:crypto';
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
vi.mock('../../backend/src/shared/account-mfa', () => ({
  storePendingMfaSecret: vi.fn(),
  confirmMfaEnrolment: vi.fn(),
  acceptMfaStep: vi.fn(),
}));
vi.mock('../../backend/src/shared/teams', () => ({ getTeamName: vi.fn() }));

import {
  confirmHandler,
  enrollHandler,
  verifyHandler,
} from '../../backend/src/auth/staff-mfa';
import {
  acceptMfaStep,
  confirmMfaEnrolment,
  storePendingMfaSecret,
} from '../../backend/src/shared/account-mfa';
import {
  getAccountByUsername,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../../backend/src/shared/accounts';
import { signMfaChallenge } from '../../backend/src/shared/mfa-challenge';
import {
  decryptSecret,
  encryptSecret,
} from '../../backend/src/shared/mfa-secret';
import {
  signStaffToken,
  verifyStaffToken,
} from '../../backend/src/shared/staff-token';
import { stepOf, totpAt } from '../../backend/src/shared/totp';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const STEP = stepOf(NOW);
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const ID = 'boss@example.com';

const base: AccountRecord = {
  accountId: ID,
  username: ID,
  role: 'MANAGER',
  displayName: 'Boss',
  passwordHash: '$2b$12$hash',
  isActive: true,
  tokenVersion: 4,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const getAccount = vi.mocked(getAccountByUsername);
const failedLogin = vi.mocked(recordFailedLogin);
const successfulLogin = vi.mocked(recordSuccessfulLogin);
const storePending = vi.mocked(storePendingMfaSecret);
const confirmEnrolment = vi.mocked(confirmMfaEnrolment);
const acceptStep = vi.mocked(acceptMfaStep);

const challenge = (version = 4, at = NOW) =>
  signMfaChallenge({ accountId: ID, tokenVersion: version }, at);

function event(payload: unknown, raw?: string): APIGatewayProxyEventV2 {
  return {
    headers: {},
    body: raw ?? JSON.stringify(payload),
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}
const body = (result: { body?: string }) => JSON.parse(result.body ?? '{}');
const pendingAccount = (): AccountRecord => ({
  ...base,
  mfaPendingSecret: encryptSecret(SECRET, ID),
});
const enrolledAccount = (
  extra: Partial<AccountRecord> = {},
): AccountRecord => ({
  ...base,
  mfaSecret: encryptSecret(SECRET, ID),
  mfaEnrolledAt: '2026-11-02T00:00:00.000Z',
  ...extra,
});
const goodCode = () => totpAt(SECRET, STEP);
const wrongCode = () => (goodCode() === '000000' ? '000001' : '000000');

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('STAFF_JWT_SECRET', 'x'.repeat(40));
  vi.stubEnv('MFA_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  getAccount.mockResolvedValue(base);
  failedLogin.mockResolvedValue({ locked: false });
  successfulLogin.mockResolvedValue(undefined);
  storePending.mockResolvedValue(true);
  confirmEnrolment.mockResolvedValue(5);
  acceptStep.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** What every one of the three steps does with a bad challenge or request. */
function sharedRules(
  call: (payload: unknown) => Promise<{ statusCode: number; body?: string }>,
  extra: Record<string, unknown>,
  prepare: () => void,
) {
  it('refuses a challenge that is expired, forged, or a staff token, with the same 401', async () => {
    prepare();
    const expired = challenge(4, new Date(NOW.getTime() - 301_000));
    const staff = signStaffToken(
      { accountId: ID, role: 'MANAGER', tokenVersion: 4 },
      NOW,
    );
    for (const challengeToken of [expired, `${challenge()}x`, staff, 'a.b.c']) {
      const result = await call({ challengeToken, ...extra });
      expect(result.statusCode).toBe(401);
      expect(body(result).error.message).toBe('Invalid or expired login step.');
    }
    expect(failedLogin).not.toHaveBeenCalled();
  });

  it('refuses a challenge for an account that changed since the password step', async () => {
    prepare();
    for (const account of [
      null,
      { ...base, isActive: false },
      { ...base, tokenVersion: 5 },
      { ...base, role: 'TECHNICIAN' as const, teamId: 'PLUMBING' },
      { ...base, accountId: 'someone-else' },
    ]) {
      getAccount.mockResolvedValue(account);
      const result = await call({ challengeToken: challenge(), ...extra });
      expect(result.statusCode).toBe(401);
    }
  });

  it('answers 429 for a locked account without checking anything', async () => {
    getAccount.mockResolvedValue({
      ...enrolledAccount(),
      mfaPendingSecret: encryptSecret(SECRET, ID),
      lockedUntil: new Date(NOW.getTime() + 90_000).toISOString(),
    });
    const result = await call({ challengeToken: challenge(), ...extra });
    expect(result.statusCode).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('90');
    expect(failedLogin).not.toHaveBeenCalled();
    expect(storePending).not.toHaveBeenCalled();
    expect(confirmEnrolment).not.toHaveBeenCalled();
    expect(acceptStep).not.toHaveBeenCalled();
  });

  it('answers 400 for a missing, empty, too long or non-string challenge and unknown fields', async () => {
    prepare();
    for (const payload of [
      { ...extra },
      { challengeToken: '', ...extra },
      { challengeToken: 5, ...extra },
      { challengeToken: 'x'.repeat(2001), ...extra },
      { challengeToken: challenge(), ...extra, extra: 1 },
      [],
    ]) {
      expect((await call(payload)).statusCode).toBe(400);
    }
    expect((await call(undefined)).statusCode).toBe(400);
  });
}

describe('POST /auth/staff/mfa/enroll', () => {
  const call = (payload: unknown) =>
    enrollHandler(payload === undefined ? event(null, 'nope') : event(payload));
  sharedRules(call, {}, () => getAccount.mockResolvedValue(base));

  it('makes a secret, keeps it pending and encrypted, and shows it once', async () => {
    const result = await call({ challengeToken: challenge() });
    const answer = body(result);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['cache-control']).toBe('no-store');
    expect(answer.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(answer.otpauthUri).toContain(`secret=${answer.secret}`);
    expect(answer.otpauthUri).toContain('SCFRMS:boss%40example.com');

    expect(storePending).toHaveBeenCalledTimes(1);
    const [account, stored, at] = storePending.mock.calls[0];
    expect(account.accountId).toBe(ID);
    expect(stored).not.toContain(answer.secret);
    expect(decryptSecret(stored, ID)).toBe(answer.secret);
    expect(at).toEqual(NOW);
  });

  it('makes a new secret each time while the setup is not confirmed', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    const a = body(await call({ challengeToken: challenge() })).secret;
    const b = body(await call({ challengeToken: challenge() })).secret;
    expect(a).not.toBe(b);
  });

  it('answers 409 for a manager who already has an authenticator', async () => {
    getAccount.mockResolvedValue(enrolledAccount());
    const result = await call({ challengeToken: challenge() });
    expect(result.statusCode).toBe(409);
    expect(body(result).error.message).toMatch(/already set up/);
    expect(storePending).not.toHaveBeenCalled();
  });

  it('answers 409 when the account changed while the secret was stored', async () => {
    storePending.mockResolvedValue(false);
    const result = await call({ challengeToken: challenge() });
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('"secret"');
  });
});

describe('POST /auth/staff/mfa/confirm', () => {
  const call = (payload: unknown) =>
    confirmHandler(
      payload === undefined ? event(null, 'nope') : event(payload),
    );
  sharedRules(call, { code: '123456' }, () =>
    getAccount.mockResolvedValue(pendingAccount()),
  );

  it('logs the manager in with the first correct code, with the raised token version', async () => {
    getAccount.mockResolvedValue(pendingAccount());

    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    const answer = body(result);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['cache-control']).toBe('no-store');
    expect(confirmEnrolment).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ID }),
      STEP,
      NOW,
    );
    expect(successfulLogin).toHaveBeenCalledWith(ID, NOW);
    expect(answer.staff).toEqual({ id: ID, name: 'Boss', role: 'MANAGER' });
    expect(verifyStaffToken(answer.accessToken, NOW)).toEqual({
      accountId: ID,
      role: 'MANAGER',
      tokenVersion: 5,
    });
  });

  it('takes the code as the app shows it, with a space', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    const code = goodCode();
    const result = await call({
      challengeToken: challenge(),
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
    });
    expect(result.statusCode).toBe(200);
  });

  it('counts a wrong code and answers 401', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    const result = await call({
      challengeToken: challenge(),
      code: wrongCode(),
    });
    expect(result.statusCode).toBe(401);
    expect(body(result).error.message).toBe('Incorrect code.');
    expect(failedLogin).toHaveBeenCalledWith(ID, NOW);
    expect(confirmEnrolment).not.toHaveBeenCalled();
    expect(successfulLogin).not.toHaveBeenCalled();
  });

  it('answers 429 when the wrong code is the one that locks the account', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    failedLogin.mockResolvedValue({
      locked: true,
      lockedUntil: new Date(NOW.getTime() + 900_000).toISOString(),
    });
    const result = await call({
      challengeToken: challenge(),
      code: wrongCode(),
    });
    expect(result.statusCode).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('900');
  });

  it('answers 409 when there is no pending secret', async () => {
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(409);
    expect(failedLogin).not.toHaveBeenCalled();
  });

  it('answers 409, and no session, when the setup changed meanwhile', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    confirmEnrolment.mockResolvedValue(null);
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('accessToken');
    expect(successfulLogin).not.toHaveBeenCalled();
  });

  it('answers 400, without counting a failure, for a code that is not six digits', async () => {
    getAccount.mockResolvedValue(pendingAccount());
    for (const code of ['12345', '1234567', 'abcdef', '', 123456, '12 34 56']) {
      const result = await call({ challengeToken: challenge(), code });
      expect(result.statusCode).toBe(400);
    }
    expect(failedLogin).not.toHaveBeenCalled();
  });

  it('checks the code against the pending secret, not another one', async () => {
    getAccount.mockResolvedValue({
      ...pendingAccount(),
      mfaPendingSecret: encryptSecret('MZXW6YTBOIMZXW6YTBOIMZXW6YTBOI', ID),
    });
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(401);
  });
});

describe('POST /auth/staff/mfa/verify', () => {
  const call = (payload: unknown) =>
    verifyHandler(payload === undefined ? event(null, 'nope') : event(payload));
  sharedRules(call, { code: '123456' }, () =>
    getAccount.mockResolvedValue(enrolledAccount()),
  );

  it('logs the manager in with a correct code and keeps the token version', async () => {
    getAccount.mockResolvedValue(enrolledAccount({ mfaLastStep: STEP - 5 }));

    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    const answer = body(result);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['cache-control']).toBe('no-store');
    expect(acceptStep).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ID }),
      STEP,
    );
    expect(successfulLogin).toHaveBeenCalledWith(ID, NOW);
    expect(verifyStaffToken(answer.accessToken, NOW)).toEqual({
      accountId: ID,
      role: 'MANAGER',
      tokenVersion: 4,
    });
  });

  it('refuses a code that was already used, and counts it', async () => {
    getAccount.mockResolvedValue(enrolledAccount({ mfaLastStep: STEP }));
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(401);
    expect(failedLogin).toHaveBeenCalledWith(ID, NOW);
    expect(acceptStep).not.toHaveBeenCalled();
    expect(successfulLogin).not.toHaveBeenCalled();
  });

  it('refuses the second of two requests that use the same code at once', async () => {
    getAccount.mockResolvedValue(enrolledAccount());
    acceptStep.mockResolvedValue(false);
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(401);
    expect(failedLogin).toHaveBeenCalledTimes(1);
    expect(successfulLogin).not.toHaveBeenCalled();
  });

  it('counts a wrong code, and answers 429 when it locks the account', async () => {
    getAccount.mockResolvedValue(enrolledAccount());
    expect(
      (await call({ challengeToken: challenge(), code: wrongCode() }))
        .statusCode,
    ).toBe(401);
    failedLogin.mockResolvedValue({
      locked: true,
      lockedUntil: new Date(NOW.getTime() + 900_000).toISOString(),
    });
    const locked = await call({
      challengeToken: challenge(),
      code: wrongCode(),
    });
    expect(locked.statusCode).toBe(429);
    expect(acceptStep).not.toHaveBeenCalled();
  });

  it('answers 409 for a manager who has not set up MFA', async () => {
    getAccount.mockResolvedValue(base);
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(409);
    expect(failedLogin).not.toHaveBeenCalled();
  });

  it('answers 400, without counting a failure, for a code that is not six digits', async () => {
    getAccount.mockResolvedValue(enrolledAccount());
    const result = await call({ challengeToken: challenge(), code: '12345' });
    expect(result.statusCode).toBe(400);
    expect(failedLogin).not.toHaveBeenCalled();
  });

  it('answers 500 and leaks nothing when the stored secret cannot be decrypted', async () => {
    getAccount.mockResolvedValue(
      enrolledAccount({ mfaSecret: encryptSecret(SECRET, 'someone-else') }),
    );
    const result = await call({
      challengeToken: challenge(),
      code: goodCode(),
    });
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain(SECRET);
  });
});
