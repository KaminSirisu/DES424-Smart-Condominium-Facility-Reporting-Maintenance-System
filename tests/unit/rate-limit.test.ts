import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  consumeLoginIpQuota,
  ticketIpQuotaClaim,
  ticketQuotaClaim,
} from '../../backend/src/shared/rate-limit.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

// 2026-10-28T10:30:00Z is 1793183400 s; its hour starts at 1793181600.
const NOW = new Date('2026-10-28T10:30:00.000Z');
const WINDOW_START = 1793181600;

describe('ticketQuotaClaim', () => {
  beforeEach(() => {
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', 'TestRateLimits');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('builds a conditional count of the current hour window for the reporter', () => {
    const { update } = ticketQuotaClaim('Uabc123', NOW);

    expect(update.TableName).toBe('TestRateLimits');
    expect(update.Key).toEqual({
      limitKey: 'TICKET_CREATE#Uabc123',
      windowStart: WINDOW_START,
    });
    expect(update.UpdateExpression).toContain('ADD #count :one');
    expect(update.ConditionExpression).toBe(
      'attribute_not_exists(#count) OR #count < :limit',
    );
    expect(update.ExpressionAttributeNames).toEqual({ '#count': 'count' });
    expect(update.ExpressionAttributeValues).toEqual({
      ':one': 1,
      ':limit': 10,
      // end of the window plus one spare window
      ':expiresAt': WINDOW_START + 7200,
    });
  });

  it('says how long until the window ends, for Retry-After', () => {
    // 30 minutes into the window, so 1800 seconds remain
    expect(ticketQuotaClaim('Uabc123', NOW).retryAfterSeconds).toBe(1800);
    expect(
      ticketQuotaClaim('Uabc123', new Date('2026-10-28T10:59:59.000Z'))
        .retryAfterSeconds,
    ).toBe(1);
  });

  it('uses a different counter in the next hour', () => {
    const next = ticketQuotaClaim(
      'Uabc123',
      new Date('2026-10-28T11:00:00.000Z'),
    );
    expect(next.update.Key.windowStart).toBe(WINDOW_START + 3600);
    expect(next.retryAfterSeconds).toBe(3600);
  });

  it('keeps separate counters per reporter', () => {
    expect(ticketQuotaClaim('Uother', NOW).update.Key.limitKey).toBe(
      'TICKET_CREATE#Uother',
    );
  });

  it('reads the limit from TICKET_RATE_LIMIT_PER_HOUR', () => {
    vi.stubEnv('TICKET_RATE_LIMIT_PER_HOUR', '3');
    expect(
      ticketQuotaClaim('Uabc123', NOW).update.ExpressionAttributeValues[
        ':limit'
      ],
    ).toBe(3);
  });

  it.each(['', 'abc', '0', '-5', '2.5'])(
    'falls back to 10 when TICKET_RATE_LIMIT_PER_HOUR is %j',
    (value) => {
      vi.stubEnv('TICKET_RATE_LIMIT_PER_HOUR', value);
      expect(
        ticketQuotaClaim('Uabc123', NOW).update.ExpressionAttributeValues[
          ':limit'
        ],
      ).toBe(10);
    },
  );

  it('fails clearly when the table name is not set', () => {
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', '');
    expect(() => ticketQuotaClaim('Uabc123', NOW)).toThrow(
      'RATE_LIMITS_TABLE_NAME environment variable is not set.',
    );
  });
});

describe('ticketIpQuotaClaim', () => {
  beforeEach(() => {
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', 'TestRateLimits');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts the current hour for the address, 30 an hour by default', () => {
    const { update, retryAfterSeconds } = ticketIpQuotaClaim(
      '203.0.113.7',
      NOW,
    );
    expect(update.Key).toEqual({
      limitKey: 'TICKET_CREATE_IP#203.0.113.7',
      windowStart: WINDOW_START,
    });
    expect(update.ExpressionAttributeValues).toEqual({
      ':one': 1,
      ':limit': 30,
      ':expiresAt': WINDOW_START + 7200,
    });
    expect(update.ConditionExpression).toBe(
      'attribute_not_exists(#count) OR #count < :limit',
    );
    expect(retryAfterSeconds).toBe(1800);
  });

  it('is a different counter from the reporter counter', () => {
    expect(ticketIpQuotaClaim('Uabc123', NOW).update.Key.limitKey).not.toBe(
      ticketQuotaClaim('Uabc123', NOW).update.Key.limitKey,
    );
  });

  it('reads the limit from TICKET_IP_LIMIT_PER_HOUR and ignores a bad value', () => {
    vi.stubEnv('TICKET_IP_LIMIT_PER_HOUR', '7');
    expect(
      ticketIpQuotaClaim('1.2.3.4', NOW).update.ExpressionAttributeValues[
        ':limit'
      ],
    ).toBe(7);
    for (const bad of ['', 'abc', '0', '-1', '2.5']) {
      vi.stubEnv('TICKET_IP_LIMIT_PER_HOUR', bad);
      expect(
        ticketIpQuotaClaim('1.2.3.4', NOW).update.ExpressionAttributeValues[
          ':limit'
        ],
      ).toBe(30);
    }
  });

  it('does not read the reporter limit', () => {
    vi.stubEnv('TICKET_RATE_LIMIT_PER_HOUR', '3');
    expect(
      ticketIpQuotaClaim('1.2.3.4', NOW).update.ExpressionAttributeValues[
        ':limit'
      ],
    ).toBe(30);
  });
});

describe('consumeLoginIpQuota', () => {
  // 10:30 is 1793183400 s; its 15 minute window starts at 10:30:00 sharp.
  const AT = new Date('2026-10-28T10:37:30.000Z');
  const LOGIN_WINDOW_START = 1793183400;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('RATE_LIMITS_TABLE_NAME', 'TestRateLimits');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts the attempt in the current 15 minute window and lets it go on', async () => {
    send.mockResolvedValue({});

    await expect(consumeLoginIpQuota('203.0.113.7', AT)).resolves.toEqual({
      allowed: true,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestRateLimits',
      Key: {
        limitKey: 'LOGIN_IP#203.0.113.7',
        windowStart: LOGIN_WINDOW_START,
      },
      UpdateExpression: 'SET expiresAt = :expiresAt ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': 20,
        ':expiresAt': LOGIN_WINDOW_START + 1800,
      },
    });
  });

  it('refuses once the limit is used up, with the time until the window ends', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    // 7.5 minutes into a 15 minute window
    await expect(consumeLoginIpQuota('203.0.113.7', AT)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 450,
    });
  });

  it('starts a new counter in the next window', async () => {
    send.mockResolvedValue({});
    await consumeLoginIpQuota(
      '203.0.113.7',
      new Date('2026-10-28T10:45:00.000Z'),
    );
    expect(send.mock.calls[0][0].input.Key.windowStart).toBe(
      LOGIN_WINDOW_START + 900,
    );
  });

  it('reads the limit from LOGIN_IP_LIMIT_PER_15_MIN and ignores a bad value', async () => {
    send.mockResolvedValue({});
    vi.stubEnv('LOGIN_IP_LIMIT_PER_15_MIN', '5');
    await consumeLoginIpQuota('1.2.3.4', AT);
    expect(
      send.mock.calls[0][0].input.ExpressionAttributeValues[':limit'],
    ).toBe(5);
    vi.stubEnv('LOGIN_IP_LIMIT_PER_15_MIN', 'many');
    await consumeLoginIpQuota('1.2.3.4', AT);
    expect(
      send.mock.calls[1][0].input.ExpressionAttributeValues[':limit'],
    ).toBe(20);
  });

  it('passes any other database error on', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(consumeLoginIpQuota('1.2.3.4', AT)).rejects.toThrow(
      'throttled',
    );
  });
});
