import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';

/**
 * Per-reporter limit on ticket creation (SR-31). The per-IP limit is an AWS
 * WAF rule on API Gateway, not code.
 *
 * RateLimits table, one counter item per reporter and hour (a fixed window):
 *
 *   PK `limitKey` = `TICKET_CREATE#<lineUserId>` / SK `windowStart` (epoch seconds)
 *
 * The increment and the limit check are one conditional UpdateItem, so
 * concurrent requests cannot go over the limit. `expiresAt` (epoch seconds)
 * is the table's TTL attribute, so old windows delete themselves; TTL must
 * be enabled on that attribute by the infrastructure. The table has no
 * stream: counting must not trigger any worker.
 *
 * A fixed window lets a reporter send up to twice the limit around a window
 * boundary. That is acceptable for spam protection.
 */

const WINDOW_SECONDS = 3600;
const DEFAULT_LIMIT_PER_WINDOW = 10;

export type QuotaResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** TICKET_RATE_LIMIT_PER_HOUR, or the default when unset or not a positive integer. */
function limitPerWindow(): number {
  const value = Number(process.env.TICKET_RATE_LIMIT_PER_HOUR);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_LIMIT_PER_WINDOW;
}

/**
 * Counts one ticket creation for this reporter. Returns allowed: false, with
 * the seconds until the next window, once the limit for the current hour is
 * used up. Callers should only count requests that would create a ticket.
 */
export async function consumeTicketQuota(
  lineUserId: string,
  now: Date = new Date(),
): Promise<QuotaResult> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const windowStart = nowSeconds - (nowSeconds % WINDOW_SECONDS);
  const windowEnd = windowStart + WINDOW_SECONDS;

  try {
    await ddb.send(
      new UpdateCommand({
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
      }),
    );
    return { allowed: true };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { allowed: false, retryAfterSeconds: windowEnd - nowSeconds };
    }
    throw err;
  }
}
