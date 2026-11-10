import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { getTicket } from '../shared/ticket-repository.js';
import type { NotificationChannel, NotificationEvent } from './channel.js';
import { lineReporterChannel } from './line-notification.js';
import { hasSent, markSent } from './notification-log.js';
import { sendWorkOrderEmail } from './work-order-email.js';

/**
 * Notification worker (SCFRMS-45, SCFRMS-46), triggered by the TicketEvents
 * table's DynamoDB Stream.
 *
 * Every ticket change writes an audit event, and that INSERT is what triggers
 * notifications: the event's `kind` decides which channels fire, and each
 * channel names its recipients (the team for email, every reporter for
 * LINE). Only INSERTs count; the notification records written here go to
 * their own table, so they never reach this stream.
 *
 * Each recipient is messaged at most once per event: hasSent is checked first
 * and markSent recorded after the send (see notification-log.ts). A temporary
 * failure is reported as a partial batch failure so Lambda retries from that
 * record; recipients that already got their message are skipped on the retry.
 * Needs ReportBatchItemFailures on the event source mapping.
 *
 * Logs name the channel only, never the recipient: a recipient can be a LINE
 * user id, which must stay out of logs (SR-35).
 */

const emailTeamChannel: NotificationChannel = {
  name: 'EMAIL_TEAM',
  kinds: ['TRIAGED'],
  recipients: async (ticket) => [ticket.teamId ?? 'UNASSIGNED'],
  send: async (ticket) => (await sendWorkOrderEmail(ticket)) === 'SENT',
};

export const CHANNELS: readonly NotificationChannel[] = [
  emailTeamChannel,
  lineReporterChannel,
];

/** The audit event of a newly inserted TicketEvents item, or null for any other record. */
function newAuditEvent(record: DynamoDBRecord): NotificationEvent | null {
  if (record.eventName !== 'INSERT') return null;
  const image = record.dynamodb?.NewImage;
  if (!image) return null;

  const ticketId = image.ticketId?.S;
  const eventId = image.id?.S;
  const kind = image.kind?.S;
  if (!ticketId || !eventId || !kind) return null;
  const toStatus = image.toStatus?.S;
  const proofPhotoId = image.proofPhotoId?.S;
  return {
    ticketId,
    eventId,
    kind,
    ...(toStatus ? { toStatus } : {}),
    ...(proofPhotoId ? { proofPhotoId } : {}),
  };
}

async function notify(event: NotificationEvent): Promise<void> {
  const channels = CHANNELS.filter((c) => c.kinds.includes(event.kind));
  if (channels.length === 0) return;

  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    console.error('Ticket for notification not found', event);
    return;
  }

  for (const channel of channels) {
    for (const recipient of await channel.recipients(ticket)) {
      const logKey = `${channel.name}:${recipient}`;
      if (await hasSent(event.ticketId, event.eventId, logKey)) continue;

      if (await channel.send(ticket, recipient, event)) {
        await markSent(
          event.ticketId,
          event.eventId,
          logKey,
          new Date().toISOString(),
        );
        console.info('Notification sent', {
          ticketId: event.ticketId,
          eventId: event.eventId,
          channel: channel.name,
        });
      }
    }
  }
}

export async function handler(
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> {
  for (const record of event.Records) {
    const auditEvent = newAuditEvent(record);
    if (!auditEvent) continue;

    try {
      await notify(auditEvent);
    } catch (err) {
      console.error('Notification failed; will retry', { auditEvent, err });
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (!sequenceNumber) throw err;
      // Lambda retries this record and every record after it.
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
    }
  }
  return { batchItemFailures: [] };
}
