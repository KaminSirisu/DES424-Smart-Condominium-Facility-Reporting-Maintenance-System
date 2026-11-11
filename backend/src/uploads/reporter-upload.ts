import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { errorResponse } from '../tickets/staff-http.js';
import { ApiError } from '../tickets/types.js';
import { handler as createUpload } from './create-upload.js';

/**
 * The first AWS intake slice has LINE Login but no staff login or JWT secret.
 * Keep the shared upload handler's staff path closed until those are deployed.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;
  try {
    const body: unknown = JSON.parse(raw ?? '');
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).purpose === 'REPAIR_PROOF'
    ) {
      return errorResponse(
        new ApiError(
          403,
          'FORBIDDEN',
          'Repair-proof uploads are not enabled in this deployment.',
        ),
        event.requestContext?.requestId ?? 'unknown',
        'createReporterUpload',
      );
    }
  } catch {
    // Let the shared handler return its normal 400 for malformed JSON.
  }
  return createUpload(event);
}
