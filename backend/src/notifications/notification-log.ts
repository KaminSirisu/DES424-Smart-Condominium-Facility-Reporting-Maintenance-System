import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamodb-client.js';
import { tableName } from '../shared/tables.js';

/**
 * Record of notifications already sent (SCFRMS-45/46), so a stream event
 * delivered twice does not send the same email or LINE message twice.
 *
 *   Notifications table: PK `ticketId` / SK `notificationKey` = `<eventId>#<channel>`
 *
 * Sending is at-least-once: callers check hasSent, send, then markSent. A
 * crash between send and mark can send a message twice, but never zero times.
 */

function notificationKey(
  ticketId: string,
  eventId: string,
  channel: string,
): { ticketId: string; notificationKey: string } {
  return { ticketId, notificationKey: `${eventId}#${channel}` };
}

/** True if this event's notification was already sent on this channel. */
export async function hasSent(
  ticketId: string,
  eventId: string,
  channel: string,
): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName('NOTIFICATIONS'),
      Key: notificationKey(ticketId, eventId, channel),
    }),
  );
  return result.Item !== undefined;
}

/** Records a sent notification. Marking twice is harmless. */
export async function markSent(
  ticketId: string,
  eventId: string,
  channel: string,
  sentAt: string,
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName('NOTIFICATIONS'),
        Item: {
          ...notificationKey(ticketId, eventId, channel),
          eventId,
          channel,
          sentAt,
        },
        ConditionExpression: 'attribute_not_exists(ticketId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
}
