import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ApiError } from './types.js';

/** HTTP helpers shared by the staff ticket endpoints. */

const TICKET_ID_MAX = 128;

export function json(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(
  err: unknown,
  requestId: string,
  operation: string,
): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ApiError) {
    return {
      ...json(err.statusCode, {
        error: { code: err.code, message: err.message, requestId },
      }),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...err.headers,
      },
    };
  }
  console.error(`${operation} failed`, { requestId, err });
  return json(500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error.',
      requestId,
    },
  });
}

/** The {ticketId} path parameter, or a 400 when it is missing or oversized. */
export function ticketIdFromPath(event: APIGatewayProxyEventV2): string {
  const id = event.pathParameters?.ticketId;
  if (!id || id.length > TICKET_ID_MAX) {
    throw new ApiError(400, 'BAD_REQUEST', 'ticketId is required.');
  }
  return id;
}

/**
 * True when a ticket transaction was cancelled because a condition failed
 * (the ticket moved on, or another request won the race).
 */
export function isConditionalCheckFailure(err: unknown): boolean {
  const e = err as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  return (
    e?.name === 'TransactionCanceledException' &&
    (e.CancellationReasons ?? []).some(
      (r) => r.Code === 'ConditionalCheckFailed',
    )
  );
}
