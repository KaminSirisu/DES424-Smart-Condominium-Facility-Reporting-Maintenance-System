import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ApiError } from '../tickets/types.js';

/**
 * The JSON object in a request body, with only the allowed fields. Anything
 * else (no body, bad JSON, not an object, an unknown field) is a 400.
 */
export function parseJsonObject(
  event: APIGatewayProxyEventV2,
  allowedFields: string[],
): Record<string, unknown> {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Request body must be a JSON object.',
    );
  }
  const body = parsed as Record<string, unknown>;

  const unknownField = Object.keys(body).find(
    (k) => !allowedFields.includes(k),
  );
  if (unknownField) {
    throw new ApiError(400, 'BAD_REQUEST', `Unknown field: ${unknownField}.`);
  }
  return body;
}
