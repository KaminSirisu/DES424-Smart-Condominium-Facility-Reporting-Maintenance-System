import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

type HealthResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export function routeHealth(method: string, path: string): HealthResult {
  const found = method === 'GET' && path === '/health';

  return {
    statusCode: found ? 200 : 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(found ? { status: 'ok' } : { error: 'not_found' }),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return routeHealth(event.requestContext.http.method, event.rawPath);
}
