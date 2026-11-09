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

describe('staff signing secret loader', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('STAFF_JWT_SECRET', '');
    vi.stubEnv('STAFF_JWT_SECRET_ARN', 'arn:aws:secretsmanager:example');
    send.mockReset();
  });

  it('fetches a generated key once for concurrent invocations', async () => {
    send.mockResolvedValue({ SecretString: 'x'.repeat(64) });
    const { ensureStaffJwtSecret } =
      await import('../../backend/src/shared/staff-secret.js');

    await Promise.all([ensureStaffJwtSecret(), ensureStaffJwtSecret()]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(process.env.STAFF_JWT_SECRET).toBe('x'.repeat(64));
  });

  it('retries after an invalid or missing value', async () => {
    send
      .mockResolvedValueOnce({ SecretString: 'short' })
      .mockResolvedValueOnce({ SecretString: 'y'.repeat(64) });
    const { ensureStaffJwtSecret } =
      await import('../../backend/src/shared/staff-secret.js');

    await expect(ensureStaffJwtSecret()).rejects.toThrow(
      'missing or too short',
    );
    await ensureStaffJwtSecret();

    expect(send).toHaveBeenCalledTimes(2);
    expect(process.env.STAFF_JWT_SECRET).toBe('y'.repeat(64));
  });
});
