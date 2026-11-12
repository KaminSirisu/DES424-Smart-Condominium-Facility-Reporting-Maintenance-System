import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Keeps a manager's TOTP secret encrypted in the Accounts table (SR-09): a
 * copy of the table or a read of one item shows nothing usable without the key.
 *
 * AES-256-GCM with a random 12 byte IV. The account id is the associated data,
 * so a blob copied onto another account's item does not decrypt. The text form
 * is `v1.<iv>.<tag>.<ciphertext>`, each part base64url; the `v1` leaves room
 * for a key change later. The key is MFA_ENCRYPTION_KEY: 32 random bytes as
 * base64 (in AWS it comes from Secrets Manager, SR-34).
 */

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function key(): Buffer {
  const value = process.env.MFA_ENCRYPTION_KEY;
  if (!value) {
    throw new Error('MFA_ENCRYPTION_KEY environment variable is not set.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes written as base64.`,
    );
  }
  return bytes;
}

export function encryptSecret(secret: string, accountId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(accountId));
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** The secret in a blob made for this account. Throws if the blob is not valid for it. */
export function decryptSecret(blob: string, accountId: string): string {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored MFA secret has an unknown format.');
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
