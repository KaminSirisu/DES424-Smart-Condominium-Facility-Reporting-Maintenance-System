import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { updateHandler } from '../accounts/staff-accounts.js';
import { ensureStaffJwtSecret } from '../shared/staff-secret.js';
import { errorResponse } from '../tickets/staff-http.js';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await ensureStaffJwtSecret();
    return await updateHandler(event);
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'updateStaffAccountBootstrap',
    );
  }
}
