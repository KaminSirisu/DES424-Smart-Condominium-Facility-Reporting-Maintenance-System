import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamodb-client';

/**
 * Record of notifications already sent (SCFRMS-45/46), so a stream event
 * delivered twice does not send the same email or LINE message twice.
 *
 *   PK `TICKET#<id>` / SK `NOTIFICATION#<eventId>#<channel>`
 *
 * Sending is at-least-once: callers check hasSent, send, then markSent. A
 * crash between send and mark can send a message twice, but never zero times.
 */

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set.');
  }
  return name;
}

function notificationKey(
  ticketId: string,
  eventId: string,
  channel: string,
): { PK: string; SK: string } {
  return {
    PK: `TICKET#${ticketId}`,
    SK: `NOTIFICATION#${eventId}#${channel}`,
  };
}

/** True if this event's notification was already sent on this channel. */
export async function hasSent(
  ticketId: string,
  eventId: string,
  channel: string,
): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
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
        TableName: tableName(),
        Item: {
          ...notificationKey(ticketId, eventId, channel),
          entityType: 'TICKET_NOTIFICATION',
          ticketId,
          eventId,
          channel,
          sentAt,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
}
