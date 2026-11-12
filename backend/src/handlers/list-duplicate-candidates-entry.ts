import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ensureStaffJwtSecret } from '../shared/staff-secret.js';
import { errorResponse } from '../tickets/staff-http.js';
import { handler as listDuplicateCandidates } from '../tickets/list-duplicate-candidates.js';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await ensureStaffJwtSecret();
    return await listDuplicateCandidates(event);
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'listDuplicateCandidatesBootstrap',
    );
  }
}
