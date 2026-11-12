import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  stepOf,
  totpAt,
  verifyTotp,
} from '../../backend/src/shared/totp';

// The RFC 6238 / RFC 4226 test secret: the ASCII text 12345678901234567890.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const at = (seconds: number) => new Date(seconds * 1000);

describe('base32 (RFC 4648 test vectors)', () => {
  const vectors: [string, string][] = [
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('encodes %s as %s and decodes it back', (plain, coded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(coded);
    expect(base32Decode(coded)?.toString()).toBe(plain);
  });

  it('decodes lower case and ignores spaces', () => {
    expect(base32Decode('mzxw 6ytb oi')?.toString()).toBe('foobar');
  });

  it('refuses text that is not base32 or is empty', () => {
    expect(base32Decode('MZXW1')).toBeNull();
    expect(base32Decode('MZXW=')).toBeNull();
    expect(base32Decode('')).toBeNull();
    expect(base32Decode('   ')).toBeNull();
  });
});

describe('totpAt', () => {
  it('matches the RFC 4226 counter values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => {
      expect(totpAt(SECRET, counter)).toBe(code);
    });
  });

  it('matches the RFC 6238 values (last six digits of the SHA-1 vectors)', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpAt(SECRET, stepOf(at(seconds)))).toBe(code);
    }
  });

  it('keeps leading zeros', () => {
    expect(totpAt(SECRET, stepOf(at(1111111109)))).toHaveLength(6);
  });

  it('throws for a secret that is not base32', () => {
    expect(() => totpAt('not base32!', 1)).toThrow(/base32/);
  });
});

describe('stepOf', () => {
  it('changes every 30 seconds', () => {
    expect(stepOf(at(0))).toBe(0);
    expect(stepOf(at(29.999))).toBe(0);
    expect(stepOf(at(30))).toBe(1);
    expect(stepOf(at(59))).toBe(1);
    expect(stepOf(at(60))).toBe(2);
  });
});

describe('verifyTotp', () => {
  const now = at(1111111111); // step 37037037
  const step = stepOf(now);

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp(SECRET, totpAt(SECRET, step), now)).toBe(step);
  });

  it('accepts one step early and one step late, no more', () => {
    expect(verifyTotp(SECRET, totpAt(SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(SECRET, totpAt(SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(SECRET, totpAt(SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(SECRET, totpAt(SECRET, step + 2), now)).toBeNull();
  });

  it('refuses a wrong code', () => {
    const right = totpAt(SECRET, step);
    const wrong = right === '000000' ? '000001' : '000000';
    expect(verifyTotp(SECRET, wrong, now)).toBeNull();
  });

  it('takes the code with spaces, as apps show it', () => {
    const code = totpAt(SECRET, step);
    expect(
      verifyTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now),
    ).toBe(step);
  });

  it('refuses a code that is not six digits', () => {
    const code = totpAt(SECRET, step);
    expect(verifyTotp(SECRET, '', now)).toBeNull();
    expect(verifyTotp(SECRET, code.slice(0, 5), now)).toBeNull();
    expect(verifyTotp(SECRET, `${code}0`, now)).toBeNull();
    expect(verifyTotp(SECRET, 'abcdef', now)).toBeNull();
    expect(verifyTotp(SECRET, `+${code.slice(1)}`, now)).toBeNull();
  });

  it('refuses a step at or before the last one used, and takes a later one', () => {
    const code = totpAt(SECRET, step);
    expect(verifyTotp(SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(SECRET, code, now, step + 1)).toBeNull();
    expect(verifyTotp(SECRET, code, now, step - 1)).toBe(step);
    // An older step inside the window is also refused once a newer one was used.
    expect(verifyTotp(SECRET, totpAt(SECRET, step - 1), now, step)).toBeNull();
    // Step 0 as "last used" blocks only step 0 and below.
    expect(verifyTotp(SECRET, code, now, 0)).toBe(step);
  });

  it('returns null for a secret that is not base32', () => {
    expect(verifyTotp('not base32!', '123456', now)).toBeNull();
  });
});

describe('generateTotpSecret', () => {
  it('makes a 32 character base32 secret that differs each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });
});

describe('otpauthUri', () => {
  it('builds the link an authenticator app reads', () => {
    const uri = otpauthUri(SECRET, 'manager@example.com');
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe(
      '/SCFRMS:manager@example.com',
    );
    expect(url.searchParams.get('secret')).toBe(SECRET);
    expect(url.searchParams.get('issuer')).toBe('SCFRMS');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });

  it('escapes the account name and takes another issuer', () => {
    const uri = otpauthUri(SECRET, 'a b@x.com', 'Other Co');
    expect(uri).toContain('/Other%20Co:a%20b%40x.com?');
    expect(new URL(uri).searchParams.get('issuer')).toBe('Other Co');
  });
});
