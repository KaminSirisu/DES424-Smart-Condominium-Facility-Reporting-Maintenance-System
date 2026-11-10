import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ensureStaffJwtSecret } from '../shared/staff-secret.js';
import { handler as createUpload } from '../uploads/create-upload.js';
import { errorResponse } from '../tickets/staff-http.js';

/** Shared reporter and technician upload route once staff writes are enabled. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    // Reporter uploads never need the staff signing secret. The common
    // handler validates malformed requests and decides which identity to use.
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : event.body;
    let body: unknown;
    try {
      body = JSON.parse(raw ?? '');
    } catch {
      // The shared handler reports the normal 400 for malformed JSON.
    }
    if (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).purpose === 'REPAIR_PROOF'
    ) {
      await ensureStaffJwtSecret();
    }
    return await createUpload(event);
  } catch (err) {
    return errorResponse(
      err,
      event.requestContext?.requestId ?? 'unknown',
      'createUploadBootstrap',
    );
  }
}
