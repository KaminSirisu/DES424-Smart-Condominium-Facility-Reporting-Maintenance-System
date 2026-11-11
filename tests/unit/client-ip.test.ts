import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { sourceIpOf } from '../../backend/src/shared/client-ip';

const withContext = (requestContext: unknown) =>
  ({ requestContext }) as unknown as APIGatewayProxyEventV2;

describe('sourceIpOf', () => {
  it('is the address API Gateway saw', () => {
    expect(sourceIpOf(withContext({ http: { sourceIp: '203.0.113.7' } }))).toBe(
      '203.0.113.7',
    );
    expect(sourceIpOf(withContext({ http: { sourceIp: '2001:db8::1' } }))).toBe(
      '2001:db8::1',
    );
  });

  it('is not taken from a header the caller can set', () => {
    const event = {
      headers: { 'x-forwarded-for': '198.51.100.9' },
      requestContext: { http: { sourceIp: '203.0.113.7' } },
    } as unknown as APIGatewayProxyEventV2;
    expect(sourceIpOf(event)).toBe('203.0.113.7');
  });

  it('is undefined when the event has none', () => {
    expect(sourceIpOf({} as APIGatewayProxyEventV2)).toBeUndefined();
    expect(sourceIpOf(withContext({}))).toBeUndefined();
    expect(sourceIpOf(withContext({ http: {} }))).toBeUndefined();
    expect(sourceIpOf(withContext({ http: { sourceIp: '' } }))).toBeUndefined();
    expect(sourceIpOf(withContext({ http: { sourceIp: 5 } }))).toBeUndefined();
  });
});
