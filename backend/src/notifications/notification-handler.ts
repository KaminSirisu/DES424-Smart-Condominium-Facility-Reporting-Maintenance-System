import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { getTicket } from '../shared/ticket-repository';
import type { TicketRecord } from '../tickets/types';
import { hasSent, markSent } from './notification-log';
import { sendWorkOrderEmail } from './work-order-email';

/**
 * Notification worker (SCFRMS-46, later SCFRMS-45), triggered by the table's
 * DynamoDB Stream.
 *
 * Every ticket change writes an audit event item (entityType TICKET_EVENT),
 * and that INSERT is what triggers notifications: the event's `kind` decides
 * which channels fire. Other items in the stream (the ticket, reporter links,
 * and the TICKET_NOTIFICATION records written here) are ignored.
 *
 * Each channel is sent at most once per event: hasSent is checked first and
 * markSent recorded after the send (see notification-log.ts). A temporary
 * failure is reported as a partial batch failure so Lambda retries from that
 * record; channels that already sent are skipped on the retry. Needs
 * ReportBatchItemFailures on the event source mapping.
 */

interface NotificationChannel {
  /** Stored in the notification log, so never rename a channel once live. */
  name: string;
  /** Audit event kinds that trigger this channel. */
  kinds: readonly string[];
  /** Returns true if a message was actually sent. */
  send(ticket: TicketRecord): Promise<boolean>;
}

export const CHANNELS: readonly NotificationChannel[] = [
  {
    name: 'EMAIL_TEAM',
    kinds: ['TRIAGED'],
    send: async (ticket) => (await sendWorkOrderEmail(ticket)) === 'SENT',
  },
];

interface AuditEvent {
  ticketId: string;
  eventId: string;
  kind: string;
}

/** The audit event of a newly written TICKET_EVENT item, or null for any other record. */
function newAuditEvent(record: DynamoDBRecord): AuditEvent | null {
  if (record.eventName !== 'INSERT') return null;
  const image = record.dynamodb?.NewImage;
  if (image?.entityType?.S !== 'TICKET_EVENT') return null;

  const ticketId = image.ticketId?.S;
  const eventId = image.id?.S;
  const kind = image.kind?.S;
  if (!ticketId || !eventId || !kind) return null;
  return { ticketId, eventId, kind };
}

async function notify(event: AuditEvent): Promise<void> {
  const channels = CHANNELS.filter((c) => c.kinds.includes(event.kind));

  const pending: NotificationChannel[] = [];
  for (const channel of channels) {
    if (!(await hasSent(event.ticketId, event.eventId, channel.name))) {
      pending.push(channel);
    }
  }
  if (pending.length === 0) return;

  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    console.error('Ticket for notification not found', event);
    return;
  }

  for (const channel of pending) {
    if (await channel.send(ticket)) {
      await markSent(
        event.ticketId,
        event.eventId,
        channel.name,
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
