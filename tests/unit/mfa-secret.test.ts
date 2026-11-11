import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
} from '../../backend/src/shared/mfa-secret';

const KEY = randomBytes(32).toString('base64');
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('mfa-secret', () => {
  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
  });

  it('gives back the secret it encrypted', () => {
    const blob = encryptSecret(SECRET, 'acct_1');
    expect(decryptSecret(blob, 'acct_1')).toBe(SECRET);
  });

  it('writes v1.<iv>.<tag>.<ciphertext> and never the secret itself', () => {
    const blob = encryptSecret(SECRET, 'acct_1');
    const parts = blob.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16);
    expect(blob).not.toContain(SECRET);
  });

  it('uses a new IV each time', () => {
    expect(encryptSecret(SECRET, 'acct_1')).not.toBe(
      encryptSecret(SECRET, 'acct_1'),
    );
  });

  it('does not decrypt for another account', () => {
    const blob = encryptSecret(SECRET, 'acct_1');
    expect(() => decryptSecret(blob, 'acct_2')).toThrow();
  });

  it('does not decrypt a changed blob', () => {
    const [v, iv, tag, ct] = encryptSecret(SECRET, 'acct_1').split('.');
    const flip = (part: string) =>
      Buffer.from(part, 'base64url')
        .map((b, i) => (i === 0 ? b ^ 1 : b))
        .toString('base64url');
    expect(() =>
      decryptSecret([v, flip(iv), tag, ct].join('.'), 'acct_1'),
    ).toThrow();
    expect(() =>
      decryptSecret([v, iv, flip(tag), ct].join('.'), 'acct_1'),
    ).toThrow();
    expect(() =>
      decryptSecret([v, iv, tag, flip(ct)].join('.'), 'acct_1'),
    ).toThrow();
  });

  it('does not decrypt with another key', () => {
    const blob = encryptSecret(SECRET, 'acct_1');
    process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(blob, 'acct_1')).toThrow();
  });

  it('refuses a blob of an unknown format', () => {
    const [, iv, tag, ct] = encryptSecret(SECRET, 'acct_1').split('.');
    expect(() => decryptSecret('nonsense', 'acct_1')).toThrow(/format/);
    expect(() =>
      decryptSecret(['v2', iv, tag, ct].join('.'), 'acct_1'),
    ).toThrow(/format/);
    expect(() => decryptSecret(['v1', iv, tag].join('.'), 'acct_1')).toThrow(
      /format/,
    );
  });

  it('fails loudly when the key is missing or the wrong size', () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(() => encryptSecret(SECRET, 'acct_1')).toThrow(/not set/);
    process.env.MFA_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encryptSecret(SECRET, 'acct_1')).toThrow(/32 bytes/);
  });
});
