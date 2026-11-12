import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * The address of the caller as API Gateway saw it (payload v2
 * `requestContext.http.sourceIp`). API Gateway sets it from the connection, so
 * a caller cannot choose it with a header such as X-Forwarded-For. Undefined
 * when the event has none (a local run or a test), and then nothing is counted
 * per address.
 */
export function sourceIpOf(event: APIGatewayProxyEventV2): string | undefined {
  const ip = event.requestContext?.http?.sourceIp;
  return typeof ip === 'string' && ip !== '' ? ip : undefined;
}
