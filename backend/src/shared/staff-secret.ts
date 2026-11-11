import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/** Load the shared staff JWT signing key before a Lambda handler uses staff-token.ts. */
let client: SecretsManagerClient | undefined;
let loading: Promise<void> | undefined;

export async function ensureStaffJwtSecret(): Promise<void> {
  // Local tests and development may inject the key directly. Deployed Lambdas
  // receive only its Secrets Manager ARN, not the key itself.
  if (process.env.STAFF_JWT_SECRET) return;

  const secretArn = process.env.STAFF_JWT_SECRET_ARN;
  if (!secretArn) {
    throw new Error('STAFF_JWT_SECRET_ARN environment variable is not set.');
  }

  loading ??= (async () => {
    client ??= new SecretsManagerClient({ region: process.env.AWS_REGION });
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const value = result.SecretString;
    if (!value || value.length < 32) {
      throw new Error('Staff JWT signing secret is missing or too short.');
    }
    process.env.STAFF_JWT_SECRET = value;
  })();

  try {
    await loading;
  } catch (err) {
    // Allow the next invocation to retry a temporary Secrets Manager failure.
    loading = undefined;
    throw err;
  }
}
