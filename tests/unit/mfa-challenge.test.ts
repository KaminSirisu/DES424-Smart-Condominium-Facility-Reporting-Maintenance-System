import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MFA_CHALLENGE_SECONDS,
  signMfaChallenge,
  verifyMfaChallenge,
} from '../../backend/src/shared/mfa-challenge';
import {
  signClaims,
  signStaffToken,
  verifyStaffToken,
} from '../../backend/src/shared/staff-token';

const NOW = new Date('2026-11-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const challenge = { accountId: 'acct_manager', tokenVersion: 2 };

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

describe('mfa-challenge', () => {
  beforeEach(() => {
    process.env.STAFF_JWT_SECRET = 'test-secret-that-is-long-enough-123456';
  });
  afterEach(() => {
    delete process.env.STAFF_JWT_SECRET;
  });

  it('is good for 5 minutes', () => {
    expect(MFA_CHALLENGE_SECONDS).toBe(300);
    const token = signMfaChallenge(challenge, NOW);
    expect(verifyMfaChallenge(token, NOW)).toEqual(challenge);
    expect(verifyMfaChallenge(token, later(299))).toEqual(challenge);
    expect(() => verifyMfaChallenge(token, later(300))).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('holds only what the code step needs', () => {
    expect(claimsOf(signMfaChallenge(challenge, NOW))).toEqual({
      purpose: 'mfa',
      account_id: 'acct_manager',
      token_version: 2,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });
  });

  it('is not a staff token', () => {
    const token = signMfaChallenge(challenge, NOW);
    expect(() => verifyStaffToken(token, NOW)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('is not made from a staff token', () => {
    const staff = signStaffToken(
      { accountId: 'acct_manager', role: 'MANAGER', tokenVersion: 2 },
      NOW,
    );
    expect(() => verifyMfaChallenge(staff, NOW)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('refuses a changed signature or garbage', () => {
    const token = signMfaChallenge(challenge, NOW);
    expect(() => verifyMfaChallenge(`${token}x`, NOW)).toThrow();
    expect(() => verifyMfaChallenge('a.b.c', NOW)).toThrow();
    expect(() => verifyMfaChallenge('', NOW)).toThrow();
  });

  it('refuses claims that are wrong in any way', () => {
    const good = {
      purpose: 'mfa',
      account_id: 'acct_manager',
      token_version: 2,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    };
    expect(verifyMfaChallenge(signClaims(good), NOW)).toEqual(challenge);

    const bad: Record<string, unknown>[] = [
      { ...good, purpose: 'other' },
      { ...good, purpose: undefined },
      { ...good, account_id: '' },
      { ...good, account_id: 5 },
      { ...good, token_version: -1 },
      { ...good, token_version: 1.5 },
      { ...good, token_version: '2' },
      { ...good, iat: 'x' },
      { ...good, exp: 1.5 },
      // Lives longer than 5 minutes.
      { ...good, exp: NOW_SECONDS + 301 },
      // Issued in the future, beyond the 60 second skew.
      { ...good, iat: NOW_SECONDS + 61, exp: NOW_SECONDS + 100 },
    ];
    for (const claims of bad) {
      expect(() => verifyMfaChallenge(signClaims(claims), NOW)).toThrow(
        expect.objectContaining({ statusCode: 401 }),
      );
    }
    // Within the skew is fine.
    expect(
      verifyMfaChallenge(
        signClaims({ ...good, iat: NOW_SECONDS + 60, exp: NOW_SECONDS + 100 }),
        NOW,
      ),
    ).toEqual(challenge);
  });

  it('fails loudly when the signing secret is not set', () => {
    delete process.env.STAFF_JWT_SECRET;
    expect(() => verifyMfaChallenge('a.b.c', NOW)).toThrow(/STAFF_JWT_SECRET/);
  });
});
