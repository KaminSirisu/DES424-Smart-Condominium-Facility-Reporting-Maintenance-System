import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Loads the key that encrypts manager MFA secrets (shared/mfa-secret.ts)
 * before a Lambda handler uses it. Same approach as shared/staff-secret.ts:
 * local tests and development may set MFA_ENCRYPTION_KEY directly, and a
 * deployed Lambda gets only the ARN of the Secrets Manager secret
 * (MFA_ENCRYPTION_KEY_ARN, SR-34) that holds 32 random bytes as base64.
 */
let client: SecretsManagerClient | undefined;
let loading: Promise<void> | undefined;

const KEY_BYTES = 32;

export async function ensureMfaEncryptionKey(): Promise<void> {
  if (process.env.MFA_ENCRYPTION_KEY) return;

  const secretArn = process.env.MFA_ENCRYPTION_KEY_ARN;
  if (!secretArn) {
    throw new Error('MFA_ENCRYPTION_KEY_ARN environment variable is not set.');
  }

  loading ??= (async () => {
    client ??= new SecretsManagerClient({ region: process.env.AWS_REGION });
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const value = result.SecretString?.trim();
    if (!value || Buffer.from(value, 'base64').length !== KEY_BYTES) {
      throw new Error(
        `MFA encryption key is missing or is not ${KEY_BYTES} bytes as base64.`,
      );
    }
    process.env.MFA_ENCRYPTION_KEY = value;
  })();

  try {
    await loading;
  } catch (err) {
    // Allow the next invocation to retry a temporary Secrets Manager failure.
    loading = undefined;
    throw err;
  }
}
