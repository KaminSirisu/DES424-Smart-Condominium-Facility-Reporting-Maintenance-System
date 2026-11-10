import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../../backend/src/shared/password.js';

describe('hashPassword and verifyPassword', () => {
  it('hashes with bcrypt cost 12 and accepts only the right password', async () => {
    const password = generatePassword();
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword(`${password}x`, hash)).resolves.toBe(false);
  });

  it('gives a different hash each time for the same password', async () => {
    const password = generatePassword();
    expect(await hashPassword(password)).not.toBe(await hashPassword(password));
  });

  it('refuses to hash a password under 12 characters', async () => {
    await expect(hashPassword('short-pass1')).rejects.toThrow(
      `at least ${MIN_PASSWORD_LENGTH}`,
    );
  });

  it('refuses to hash a password over 72 bytes, which bcrypt would cut short', async () => {
    await expect(hashPassword('a'.repeat(73))).rejects.toThrow('72 bytes');
  });

  it('counts bytes, not characters, for the 72 byte limit', async () => {
    // 25 euro signs are 75 bytes in UTF-8.
    await expect(hashPassword('\u20ac'.repeat(25))).rejects.toThrow('72 bytes');
  });

  it('does not accept a login password over 72 bytes', async () => {
    const hash = bcrypt.hashSync('a'.repeat(72), 4);
    await expect(verifyPassword('a'.repeat(73), hash)).resolves.toBe(false);
  });

  it('answers false for an unknown account', async () => {
    await expect(verifyPassword(generatePassword(), null)).resolves.toBe(false);
  });

  it('answers false, not an error, for a stored value that is not a hash', async () => {
    await expect(
      verifyPassword(generatePassword(), 'not-a-hash'),
    ).resolves.toBe(false);
  });
});

describe('generatePassword', () => {
  it('is 20 characters by default and never repeats', () => {
    const first = generatePassword();
    expect(first).toHaveLength(20);
    expect(generatePassword()).not.toBe(first);
  });

  it('leaves out the characters that are easy to misread', () => {
    const sample = Array.from({ length: 50 }, () => generatePassword()).join(
      '',
    );
    expect(sample).toMatch(/^[A-Za-z0-9]+$/);
    expect(sample).not.toMatch(/[0O1lI]/);
  });

  it('can be longer, but never shorter than 12', () => {
    expect(generatePassword(32)).toHaveLength(32);
    expect(() => generatePassword(11)).toThrow('at least 12');
    expect(() => generatePassword(12.5)).toThrow();
  });
});
