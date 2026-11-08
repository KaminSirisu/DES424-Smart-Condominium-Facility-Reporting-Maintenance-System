import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ticketQuotaClaim } from '../../backend/src/shared/rate-limit.js';

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
