import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * The entry points the infrastructure wires to the routes that need the staff
 * signing secret. In AWS the Lambda gets only the ARN of the secret, so each
 * entry loads it first and then runs the route's handler; an entry that calls
 * the handler directly would answer 500 on every request.
 */
const CASES: [entry: string, target: string][] = [
  ['staff-login-entry', 'auth/staff-login'],
  ['staff-me-entry', 'auth/staff-me'],
  ['list-tickets-entry', 'tickets/list-tickets'],
  ['get-ticket-entry', 'tickets/get-ticket'],
  ['get-photo-access-entry', 'tickets/get-photo-access'],
  ['set-status-entry', 'tickets/set-status'],
  ['merge-tickets-entry', 'tickets/merge-tickets'],
  ['list-ticket-events-entry', 'tickets/list-ticket-events'],
  ['list-duplicate-candidates-entry', 'tickets/list-duplicate-candidates'],
  ['set-priority-entry', 'tickets/set-priority'],
  ['reassign-ticket-entry', 'tickets/reassign-ticket'],
  ['get-dashboard-summary-entry', 'tickets/get-dashboard-summary'],
  ['get-dashboard-history-entry', 'tickets/get-dashboard-history'],
];

const event = {
  headers: {},
  requestContext: { requestId: 'req-9', http: { method: 'GET' } },
} as unknown as APIGatewayProxyEventV2;

describe.each(CASES)('%s', (entry, target) => {
  const ensureSecret = vi.fn();
  const routeHandler = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('../../backend/src/shared/staff-secret', () => ({
      ensureStaffJwtSecret: ensureSecret,
    }));
    vi.doMock(`../../backend/src/${target}`, () => ({
      handler: routeHandler,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  async function load() {
    return (await import(`../../backend/src/handlers/${entry}`)) as {
      handler: (e: APIGatewayProxyEventV2) => Promise<{
        statusCode?: number;
        body?: string;
      }>;
    };
  }

  it('loads the staff signing secret first, then runs the handler and returns its answer', async () => {
    const order: string[] = [];
    ensureSecret.mockImplementation(async () => {
      order.push('secret');
    });
    routeHandler.mockImplementation(async () => {
      order.push('handler');
      return { statusCode: 200, body: '{"ok":true}' };
    });

    const { handler } = await load();
    const result = await handler(event);

    expect(order).toEqual(['secret', 'handler']);
    expect(routeHandler).toHaveBeenCalledWith(event);
    expect(result).toEqual({ statusCode: 200, body: '{"ok":true}' });
  });

  it('answers 500 without running the handler when the secret cannot be loaded', async () => {
    ensureSecret.mockRejectedValue(new Error('secrets manager down'));

    const { handler } = await load();
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body ?? '').error).toMatchObject({
      code: 'INTERNAL_ERROR',
      requestId: 'req-9',
    });
    expect(result.body).not.toContain('secrets manager down');
    expect(routeHandler).not.toHaveBeenCalled();
  });
});
