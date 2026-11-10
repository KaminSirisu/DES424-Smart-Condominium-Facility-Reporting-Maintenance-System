import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STAFF_TOKEN_MAX_SECONDS,
  signStaffToken,
  staffFromAuthorization,
  verifyStaffToken,
} from '../../backend/src/shared/staff-token';
import type { StaffIdentity } from '../../backend/src/shared/staff-token';

const SECRET = 'test-secret-that-is-long-enough-123456';
const NOW = new Date('2026-11-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const technician: StaffIdentity = {
  accountId: 'acct_plumbing',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  tokenVersion: 3,
};
const manager: StaffIdentity = {
  accountId: 'acct_manager',
  role: 'MANAGER',
  tokenVersion: 0,
};

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Builds a token the way another implementation would, signed with `secret`. */
function forge(
  claims: Record<string, unknown>,
  options: { header?: Record<string, unknown>; secret?: string } = {},
): string {
  const input = `${b64(options.header ?? { alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(input)
    .digest('base64url');
  return `${input}.${signature}`;
}

const goodClaims = {
  account_id: 'acct_plumbing',
  role: 'TECHNICIAN',
  team_id: 'PLUMBING',
  token_version: 3,
  iat: NOW_SECONDS,
  exp: NOW_SECONDS + 3600,
};

function rejects(token: string, now: Date = NOW): void {
  expect(() => verifyStaffToken(token, now)).toThrowError(
    expect.objectContaining({
      name: 'ApiError',
      statusCode: 401,
      code: 'UNAUTHORIZED',
    }),
  );
}

describe('staff token', () => {
  beforeEach(() => {
    vi.stubEnv('STAFF_JWT_SECRET', SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('signStaffToken and verifyStaffToken', () => {
    it('round-trips a technician', () => {
      const token = signStaffToken(technician, NOW);
      expect(verifyStaffToken(token, NOW)).toEqual(technician);
    });

    it('round-trips a manager, who has no team', () => {
      const identity = verifyStaffToken(signStaffToken(manager, NOW), NOW);
      expect(identity).toEqual(manager);
      expect(identity).not.toHaveProperty('teamId');
    });

    it('accepts a token made by another implementation of the same format', () => {
      expect(verifyStaffToken(forge(goodClaims), NOW)).toEqual(technician);
    });

    it('lives 12 hours by default and never longer', () => {
      expect(STAFF_TOKEN_MAX_SECONDS).toBe(43_200);
      const token = signStaffToken(technician, NOW);
      expect(
        verifyStaffToken(token, new Date(NOW.getTime() + 43_199_000)),
      ).toEqual(technician);
      rejects(token, new Date(NOW.getTime() + 43_200_000));
      expect(() => signStaffToken(technician, NOW, 43_201)).toThrow(
        'between 1 second and 12 hours',
      );
      expect(() => signStaffToken(technician, NOW, 0)).toThrow();
    });
  });

  describe('rejects', () => {
    it('an expired token', () => {
      rejects(forge({ ...goodClaims, exp: NOW_SECONDS }));
      rejects(forge({ ...goodClaims, exp: NOW_SECONDS - 1 }));
    });

    it('a token issued in the future, beyond a minute of clock skew', () => {
      expect(
        verifyStaffToken(forge({ ...goodClaims, iat: NOW_SECONDS + 60 }), NOW),
      ).toEqual(technician);
      rejects(forge({ ...goodClaims, iat: NOW_SECONDS + 61 }));
    });

    it('a token that claims to live longer than 12 hours', () => {
      rejects(forge({ ...goodClaims, exp: NOW_SECONDS + 43_201 }));
    });

    it('a token signed with another secret', () => {
      rejects(
        forge(goodClaims, { secret: 'another-secret-that-is-long-enough-99' }),
      );
    });

    it('a token whose payload was changed after signing', () => {
      const [header, , signature] = signStaffToken(technician, NOW).split('.');
      const promoted = b64({
        ...goodClaims,
        role: 'MANAGER',
        team_id: undefined,
      });
      rejects(`${header}.${promoted}.${signature}`);
    });

    it('a token with a cut or padded signature', () => {
      const token = signStaffToken(technician, NOW);
      rejects(token.slice(0, -2));
      rejects(`${token}AAAA`);
    });

    it.each([
      ['alg none', { alg: 'none', typ: 'JWT' }],
      ['another algorithm', { alg: 'HS512', typ: 'JWT' }],
      ['no algorithm', { typ: 'JWT' }],
    ])('a token using %s', (_label, header) => {
      rejects(forge(goodClaims, { header }));
    });

    it('an unsigned token', () => {
      rejects(`${b64({ alg: 'none' })}.${b64(goodClaims)}.`);
    });

    it.each([
      ['empty', ''],
      ['not a token', 'hello'],
      ['two parts', 'aaa.bbb'],
      ['four parts', 'a.b.c.d'],
      ['an empty part', 'a..c'],
      ['garbage parts', '!!!.???.***'],
    ])('a malformed token (%s)', (_label, token) => {
      rejects(token);
    });

    it.each([
      ['no account', { account_id: undefined }],
      ['an empty account', { account_id: '' }],
      ['a numeric account', { account_id: 7 }],
      ['an unknown role', { role: 'ADMIN' }],
      ['no role', { role: undefined }],
      ['a technician without a team', { team_id: undefined }],
      ['a technician with an unknown team', { team_id: 'ROOFING' }],
      ['no token version', { token_version: undefined }],
      ['a negative token version', { token_version: -1 }],
      ['a fractional token version', { token_version: 1.5 }],
      ['no expiry', { exp: undefined }],
      ['a text expiry', { exp: 'tomorrow' }],
      ['no issue time', { iat: undefined }],
    ])('a token with %s', (_label, change) => {
      rejects(forge({ ...goodClaims, ...change }));
    });

    it('never reveals why in the message', () => {
      for (const token of ['x.y.z', forge({ ...goodClaims, exp: 1 })]) {
        try {
          verifyStaffToken(token, NOW);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe(
            'Invalid or expired staff token.',
          );
        }
      }
    });
  });

  describe('the secret', () => {
    it('fails clearly when it is not set', () => {
      vi.stubEnv('STAFF_JWT_SECRET', '');
      expect(() => verifyStaffToken('a.b.c', NOW)).toThrow(
        'STAFF_JWT_SECRET environment variable is not set.',
      );
      expect(() => signStaffToken(technician, NOW)).toThrow(
        'STAFF_JWT_SECRET environment variable is not set.',
      );
    });

    it('refuses a short secret', () => {
      vi.stubEnv('STAFF_JWT_SECRET', 'too-short');
      expect(() => signStaffToken(technician, NOW)).toThrow(
        'at least 32 characters',
      );
    });

    it('is never part of an error message', () => {
      try {
        verifyStaffToken('a.b.c', NOW);
      } catch (err) {
        expect((err as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('staffFromAuthorization', () => {
    it('reads the identity from a bearer header', () => {
      const header = `Bearer ${signStaffToken(technician, NOW)}`;
      expect(staffFromAuthorization(header, NOW)).toEqual(technician);
    });

    it.each([undefined, '', 'Basic abc', 'Bearer'])(
      'answers 401 for the header %j',
      (header) => {
        expect(() => staffFromAuthorization(header, NOW)).toThrowError(
          expect.objectContaining({ statusCode: 401 }),
        );
      },
    );

    it('answers 401 for a bad token in a bearer header', () => {
      expect(() => staffFromAuthorization('Bearer a.b.c', NOW)).toThrowError(
        expect.objectContaining({ statusCode: 401 }),
      );
    });
  });
});
