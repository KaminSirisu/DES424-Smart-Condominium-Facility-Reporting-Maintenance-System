import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, built on RFC 4226) for the manager
 * login (SR-09). The settings are the ones every authenticator app assumes:
 * HMAC-SHA1, 6 digits, a 30 second step. A secret is 20 random bytes, written
 * as unpadded base32 (RFC 4648) so it can be typed or put in a QR code.
 */

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
/** Steps either side of the current one that are still accepted (clock drift). */
const WINDOW_STEPS = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes of a base32 text (case and spaces ignored), or null if it is not base32. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/\s+/g, '').toUpperCase();
  if (clean === '') return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The time step a moment falls in. */
export function stepOf(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an authenticator shows for a base32 secret during `step`. */
export function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('TOTP secret is not valid base32.');
  return hotp(key, step);
}

/**
 * The step a code was made for, or null if the code is wrong. Only the current
 * step and one step either side are tried, and a step at or before
 * `lastUsedStep` never matches, so a code that was already accepted cannot be
 * used again.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep?: number,
): number | null {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const key = base32Decode(secret);
  if (!key) return null;

  const current = stepOf(now);
  let matched: number | null = null;
  // Every step is compared, so the time taken does not show which one matched.
  for (
    let step = current - WINDOW_STEPS;
    step <= current + WINDOW_STEPS;
    step++
  ) {
    const same = timingSafeEqual(
      Buffer.from(hotp(key, step)),
      Buffer.from(given),
    );
    if (same && (lastUsedStep === undefined || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** The link an authenticator app reads from a QR code to add the account. */
export function otpauthUri(
  secret: string,
  accountName: string,
  issuer = 'SCFRMS',
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
