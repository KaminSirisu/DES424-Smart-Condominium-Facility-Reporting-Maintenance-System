import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: { SecretId: string }) {}
  },
}));

const KEY = randomBytes(32).toString('base64');

describe('MFA encryption key loader', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MFA_ENCRYPTION_KEY', '');
    vi.stubEnv('MFA_ENCRYPTION_KEY_ARN', 'arn:aws:secretsmanager:example');
    send.mockReset();
  });

  it('does nothing when the key is already set', async () => {
    vi.stubEnv('MFA_ENCRYPTION_KEY', KEY);
    const { ensureMfaEncryptionKey } =
      await import('../../backend/src/shared/mfa-key.js');
    await ensureMfaEncryptionKey();
    expect(send).not.toHaveBeenCalled();
  });

  it('fetches the key once for concurrent invocations and keeps it', async () => {
    send.mockResolvedValue({ SecretString: `${KEY}\n` });
    const { ensureMfaEncryptionKey } =
      await import('../../backend/src/shared/mfa-key.js');

    await Promise.all([ensureMfaEncryptionKey(), ensureMfaEncryptionKey()]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      SecretId: 'arn:aws:secretsmanager:example',
    });
    expect(process.env.MFA_ENCRYPTION_KEY).toBe(KEY);
  });

  it('refuses a missing value or one of the wrong size, and retries later', async () => {
    send
      .mockResolvedValueOnce({ SecretString: undefined })
      .mockResolvedValueOnce({
        SecretString: randomBytes(16).toString('base64'),
      })
      .mockResolvedValueOnce({ SecretString: KEY });
    const { ensureMfaEncryptionKey } =
      await import('../../backend/src/shared/mfa-key.js');

    await expect(ensureMfaEncryptionKey()).rejects.toThrow(/32 bytes/);
    expect(process.env.MFA_ENCRYPTION_KEY).toBe('');
    await expect(ensureMfaEncryptionKey()).rejects.toThrow(/32 bytes/);
    await ensureMfaEncryptionKey();
    expect(process.env.MFA_ENCRYPTION_KEY).toBe(KEY);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('needs the ARN when the key is not set', async () => {
    vi.stubEnv('MFA_ENCRYPTION_KEY_ARN', '');
    const { ensureMfaEncryptionKey } =
      await import('../../backend/src/shared/mfa-key.js');
    await expect(ensureMfaEncryptionKey()).rejects.toThrow(
      /MFA_ENCRYPTION_KEY_ARN/,
    );
  });
});
