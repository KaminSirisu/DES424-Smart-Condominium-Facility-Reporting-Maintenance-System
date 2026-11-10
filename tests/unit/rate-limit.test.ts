import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { consumeTicketQuota } from '../../backend/src/shared/rate-limit.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

// 2026-10-28T10:30:00Z is 1793183400 s; its hour starts at 1793181600.
const NOW = new Date('2026-10-28T10:30:00.000Z');
const WINDOW_START = 1793181600;

function sentInput(): {
  TableName: string;
  Key: { limitKey: string; windowStart: number };
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  return send.mock.calls[0][0].input;
}

describe('consumeTicketQuota', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', 'TestRateLimits');
    send.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts the request in the current hour window and allows it', async () => {
    await expect(consumeTicketQuota('Uabc123', NOW)).resolves.toEqual({
      allowed: true,
    });

    const input = sentInput();
    expect(input.TableName).toBe('TestRateLimits');
    expect(input.Key).toEqual({
      limitKey: 'TICKET_CREATE#Uabc123',
      windowStart: WINDOW_START,
    });
    expect(input.UpdateExpression).toContain('ADD #count :one');
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(#count) OR #count < :limit',
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ':one': 1,
      ':limit': 10,
      // end of the window plus one spare window
      ':expiresAt': WINDOW_START + 7200,
    });
  });

  it('uses a different counter in the next hour', async () => {
    await consumeTicketQuota('Uabc123', new Date('2026-10-28T11:00:00.000Z'));
    expect(sentInput().Key.windowStart).toBe(WINDOW_START + 3600);
  });

  it('keeps separate counters per reporter', async () => {
    await consumeTicketQuota('Uother', NOW);
    expect(sentInput().Key.limitKey).toBe('TICKET_CREATE#Uother');
  });

  it('refuses once the limit is used up and says when to retry', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('conditional'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    // 30 minutes into the window, so 1800 seconds remain
    await expect(consumeTicketQuota('Uabc123', NOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1800,
    });
  });

  it('reads the limit from TICKET_RATE_LIMIT_PER_HOUR', async () => {
    vi.stubEnv('TICKET_RATE_LIMIT_PER_HOUR', '3');
    await consumeTicketQuota('Uabc123', NOW);
    expect(sentInput().ExpressionAttributeValues[':limit']).toBe(3);
  });

  it.each(['', 'abc', '0', '-5', '2.5'])(
    'falls back to 10 when TICKET_RATE_LIMIT_PER_HOUR is %j',
    async (value) => {
      vi.stubEnv('TICKET_RATE_LIMIT_PER_HOUR', value);
      await consumeTicketQuota('Uabc123', NOW);
      expect(sentInput().ExpressionAttributeValues[':limit']).toBe(10);
    },
  );

  it('rethrows other DynamoDB errors', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(consumeTicketQuota('Uabc123', NOW)).rejects.toThrow(
      'throttled',
    );
  });

  it('fails clearly when the table name is not set', async () => {
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', '');
    await expect(consumeTicketQuota('Uabc123', NOW)).rejects.toThrow(
      'RATE_LIMITS_TABLE_NAME environment variable is not set.',
    );
  });
});
