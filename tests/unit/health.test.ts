import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, routeHealth } from '../../backend/src/handlers/health';

describe('health route', () => {
  it('returns a healthy response for GET /health', () => {
    const response = routeHealth('GET', '/health');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')).toEqual({ status: 'ok' });
  });

  it('rejects other routes and methods', () => {
    expect(routeHealth('POST', '/health').statusCode).toBe(404);
    expect(routeHealth('GET', '/tickets').statusCode).toBe(404);
  });

  it('accepts an API Gateway HTTP event', async () => {
    const event = {
      rawPath: '/health',
      requestContext: { http: { method: 'GET' } },
    } as APIGatewayProxyEventV2;

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')).toEqual({ status: 'ok' });
  });
});
