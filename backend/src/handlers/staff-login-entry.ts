import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { handler as login } from '../auth/staff-login.js';
import { ensureStaffJwtSecret } from '../shared/staff-secret.js';
import { errorResponse } from '../tickets/staff-http.js';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await ensureStaffJwtSecret();
    return await login(event);
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'staffLoginBootstrap',
    );
  }
}
