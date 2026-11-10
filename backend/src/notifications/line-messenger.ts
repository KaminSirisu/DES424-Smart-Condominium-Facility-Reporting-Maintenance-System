import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Pushes messages to a reporter's LINE chat through the Messaging API
 * (SCFRMS-45). https://developers.line.biz/en/reference/messaging-api/#send-push-message
 *
 * The reporter's LINE user ID comes from the LIFF login, so the LIFF channel
 * and the Messaging API channel must sit under the same LINE provider (SR-05),
 * and the reporter must have added the Official Account as a friend.
 */

/** A LINE message object, for example a Flex Message. */
export interface LineMessage {
  type: string;
  [key: string]: unknown;
}

/** The LINE call, behind an interface so tests need no network. */
export interface LineSender {
  push(to: string, messages: LineMessage[], retryKey: string): Promise<void>;
}

export class LinePushError extends Error {
  constructor(public readonly status: number) {
    super(`LINE push failed with status ${status}.`);
    this.name = 'LinePushError';
  }

  /**
   * True when retrying cannot help (the request itself is rejected, for
   * example the user never added the Official Account). Rate limits, server
   * errors and rejected credentials are not permanent: the credentials can be
   * fixed and the message sent on a later retry.
   */
  get permanent(): boolean {
    const retryable =
      this.status === 401 ||
      this.status === 403 ||
      this.status === 429 ||
      this.status >= 500;
    return this.status >= 400 && !retryable;
  }
}

/**
 * A stable UUID for one message to one user. LINE remembers a retry key for
 * 24 hours and does not deliver the same key twice, so a retry after a
 * timeout cannot produce a duplicate message.
 */
export function retryKeyFor(eventId: string, lineUserId: string): string {
  const hex = createHash('sha256')
    .update(`${eventId}\n${lineUserId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export const lineSender: LineSender = {
  async push(to, messages, retryKey) {
    const token = await lineChannelAccessToken();
    if (!token) {
      throw new Error(
        'LINE_CHANNEL_ACCESS_TOKEN environment variable is not set.',
      );
    }

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Line-Retry-Key': retryKey,
      },
      body: JSON.stringify({ to, messages }),
    });

    // 409 means LINE already accepted a request with this retry key.
    if (response.ok || response.status === 409) return;
    throw new LinePushError(response.status);
  },
};

let secretClient: SecretsManagerClient | undefined;
let cachedToken: { value: string; expiresAt: number } | undefined;

/** Read the token at runtime so it is not exposed in Lambda configuration. */
async function lineChannelAccessToken(): Promise<string | undefined> {
  const secretArn = process.env.LINE_CHANNEL_ACCESS_TOKEN_SECRET_ARN;
  if (!secretArn) return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now())
    return cachedToken.value;

  secretClient ??= new SecretsManagerClient({ region: process.env.AWS_REGION });
  const result = await secretClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const value = result.SecretString;
  if (!value) throw new Error('LINE channel access token secret is empty.');
  cachedToken = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}
