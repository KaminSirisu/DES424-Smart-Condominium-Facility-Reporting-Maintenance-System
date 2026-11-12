import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';

/**
 * Rate limits (SR-09, SR-31). Every limit is a counter in the RateLimits
 * table, one item per key and window (a fixed window):
 *
 *   PK `limitKey` / SK `windowStart` (epoch seconds)
 *
 *   TICKET_CREATE#<lineUserId>   10 tickets per hour per reporter (SR-31)
 *   TICKET_CREATE_IP#<ip>        30 tickets per hour per address (SR-31)
 *   LOGIN_IP#<ip>                20 staff logins per 15 minutes per address (SR-09)
 *
 * The addresses are the ones API Gateway reports (shared/client-ip.ts). There
 * is no web application firewall in front of the API (HTTP API cannot have
 * one), so the per-address limits are counted here, after the Lambda has been
 * called: they stop one address from creating tickets or trying logins without
 * end, not from using up Lambda calls. Several people can share an address
 * (the building's Wi-Fi), which is why the limits are generous.
 *
 * Ticket creation is not counted in a call of its own: `ticketQuotaClaim()` and
 * `ticketIpQuotaClaim()` build the counter updates, and `createTicket()`
 * (shared/ticket-repository.ts) writes them in the same transaction as the
 * ticket. So a ticket that cannot be created, including one that loses a race
 * with a retry of the same request, never uses up a quota, and concurrent
 * requests cannot go over a limit because each update is conditional. The login
 * counts every attempt, right or wrong, with `consumeLoginIpQuota()`.
 * `expiresAt` (epoch seconds) is the table's TTL attribute, so old windows
 * delete themselves; TTL must be enabled on that attribute by the
 * infrastructure. The table has no stream: counting must not trigger any
 * worker.
 *
 * A fixed window lets a caller send up to twice the limit around a window
 * boundary. That is acceptable for spam protection.
 */

const HOUR_SECONDS = 3600;
const LOGIN_WINDOW_SECONDS = 900;
const DEFAULT_TICKETS_PER_REPORTER_PER_HOUR = 10;
const DEFAULT_TICKETS_PER_IP_PER_HOUR = 30;
const DEFAULT_LOGINS_PER_IP_PER_WINDOW = 20;

/** The named environment variable, or `fallback` when unset or not a positive integer. */
function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** One counter update, to be written alone or inside a transaction. */
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

function windowClaim(
  limitKey: string,
  windowSeconds: number,
  limit: number,
  now: Date,
): TicketQuotaClaim {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);
  const windowEnd = windowStart + windowSeconds;

  return {
    update: {
      TableName: tableName('RATE_LIMITS'),
      Key: { limitKey, windowStart },
      UpdateExpression: 'SET expiresAt = :expiresAt ADD #count :one',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        // Kept one extra window so a clock skew never deletes a live counter.
        ':expiresAt': windowEnd + windowSeconds,
        ':one': 1,
        ':limit': limit,
      },
    },
    retryAfterSeconds: windowEnd - nowSeconds,
  };
}

/**
 * The claim for one ticket creation by this reporter in the current hour
 * (TICKET_RATE_LIMIT_PER_HOUR, default 10). The update fails its condition once
 * the limit for the hour is used up.
 */
export function ticketQuotaClaim(
  lineUserId: string,
  now: Date = new Date(),
): TicketQuotaClaim {
  return windowClaim(
    `TICKET_CREATE#${lineUserId}`,
    HOUR_SECONDS,
    limitFromEnv(
      'TICKET_RATE_LIMIT_PER_HOUR',
      DEFAULT_TICKETS_PER_REPORTER_PER_HOUR,
    ),
    now,
  );
}

/**
 * The claim for one ticket creation from this address in the current hour
 * (TICKET_IP_LIMIT_PER_HOUR, default 30).
 */
export function ticketIpQuotaClaim(
  ip: string,
  now: Date = new Date(),
): TicketQuotaClaim {
  return windowClaim(
    `TICKET_CREATE_IP#${ip}`,
    HOUR_SECONDS,
    limitFromEnv('TICKET_IP_LIMIT_PER_HOUR', DEFAULT_TICKETS_PER_IP_PER_HOUR),
    now,
  );
}

export type LoginQuotaResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts one staff login attempt from this address in the current 15 minute
 * window (LOGIN_IP_LIMIT_PER_15_MIN, default 20) and says whether it may go on.
 * Every attempt counts, whether the password is right or not.
 */
export async function consumeLoginIpQuota(
  ip: string,
  now: Date = new Date(),
): Promise<LoginQuotaResult> {
  const claim = windowClaim(
    `LOGIN_IP#${ip}`,
    LOGIN_WINDOW_SECONDS,
    limitFromEnv('LOGIN_IP_LIMIT_PER_15_MIN', DEFAULT_LOGINS_PER_IP_PER_WINDOW),
    now,
  );
  try {
    await ddb.send(new UpdateCommand(claim.update));
    return { allowed: true };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { allowed: false, retryAfterSeconds: claim.retryAfterSeconds };
    }
    throw err;
  }
}
