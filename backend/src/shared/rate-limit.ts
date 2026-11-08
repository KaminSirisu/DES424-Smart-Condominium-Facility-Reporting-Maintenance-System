import { tableName } from './tables.js';

/**
 * Per-reporter limit on ticket creation (SR-31). The per-IP limit is not part
 * of this code: it needs a web application firewall or another front door in
 * front of the API (see docs/database/implementation-notes.md).
 *
 * RateLimits table, one counter item per reporter and hour (a fixed window):
 *
 *   PK `limitKey` = `TICKET_CREATE#<lineUserId>` / SK `windowStart` (epoch seconds)
 *
 * The count is not made in a call of its own: `ticketQuotaClaim()` builds the
 * counter update, and `createTicket()` (shared/ticket-repository.ts) writes it
 * in the same transaction as the ticket. So a ticket that cannot be created,
 * including one that loses a race with a retry of the same request, never uses
 * up the reporter's quota, and concurrent requests cannot go over the limit
 * because the update is conditional. `expiresAt` (epoch seconds) is the
 * table's TTL attribute, so old windows delete themselves; TTL must be enabled
 * on that attribute by the infrastructure. The table has no stream: counting
 * must not trigger any worker.
 *
 * A fixed window lets a reporter send up to twice the limit around a window
 * boundary. That is acceptable for spam protection.
 */

const WINDOW_SECONDS = 3600;
const DEFAULT_LIMIT_PER_WINDOW = 10;

/** TICKET_RATE_LIMIT_PER_HOUR, or the default when unset or not a positive integer. */
function limitPerWindow(): number {
  const value = Number(process.env.TICKET_RATE_LIMIT_PER_HOUR);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_LIMIT_PER_WINDOW;
}

/** The counter update of one ticket creation, to be written with the ticket. */
export interface TicketQuotaClaim {
  update: {
    TableName: string;
    Key: { limitKey: string; windowStart: number };
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  /** Seconds until the current window ends: the Retry-After of a refusal. */
  retryAfterSeconds: number;
}

/**
 * The claim for one ticket creation by this reporter in the current hour. The
 * update fails its condition once the limit for the hour is used up.
 */
export function ticketQuotaClaim(
  lineUserId: string,
  now: Date = new Date(),
): TicketQuotaClaim {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const windowStart = nowSeconds - (nowSeconds % WINDOW_SECONDS);
  const windowEnd = windowStart + WINDOW_SECONDS;

  return {
    update: {
      TableName: tableName('RATE_LIMITS'),
      Key: { limitKey: `TICKET_CREATE#${lineUserId}`, windowStart },
      UpdateExpression: 'SET expiresAt = :expiresAt ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        // Kept one extra window so a clock skew never deletes a live counter.
        ':expiresAt': windowEnd + WINDOW_SECONDS,
        ':one': 1,
        ':limit': limitPerWindow(),
      },
    },
    retryAfterSeconds: windowEnd - nowSeconds,
  };
}
