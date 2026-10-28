import { ApiError } from '../tickets/types';

/**
 * Verifies a LINE ID token server-side and returns the verified reporter
 * identity. Never trust a LINE user ID supplied directly by the client —
 * this is the only place that identity may come from.
 *
 * Calls LINE's own token-verification endpoint rather than checking the
 * JWT signature locally — simpler for this project's scale, and LINE's
 * endpoint also checks expiry and that the token was issued for our
 * channel. https://developers.line.biz/en/reference/line-login/#verify-id-token
 */

interface LineVerifyResponse {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
}

export async function verifyLineToken(idToken: string): Promise<string> {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!channelId) {
    throw new Error('LINE_LOGIN_CHANNEL_ID environment variable is not set.');
  }

  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      id_token: idToken,
      client_id: channelId,
    }),
  });

  if (!response.ok) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired LINE token.');
  }

  const payload = (await response.json()) as LineVerifyResponse;
  if (!payload.sub) {
    throw new ApiError(401, 'UNAUTHORIZED', 'LINE token is missing a subject.');
  }

  return payload.sub; // the verified LINE user ID
}

/** Extracts the Bearer token from an Authorization header, or null if absent/malformed. */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
