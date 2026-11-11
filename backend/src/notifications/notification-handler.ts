import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { getTicket } from '../shared/ticket-repository.js';
import type { NotificationChannel, NotificationEvent } from './channel.js';
import { lineReporterChannel } from './line-notification.js';
import { hasSent, markSent } from './notification-log.js';
import { emailSupervisorsChannel } from './sla-breach-notification.js';
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
 * The channels are independent. A failing channel, or a failing recipient,
 * never stops the others from being tried for the same event: everything that
 * can be sent is sent, and only then is the failure reported for the retry.
 * So the work order email (SES) cannot hold back a LINE message. The
 * NOTIFICATION_CHANNELS environment variable, a comma separated list of
 * channel names, limits what a deployment runs, for example only LINE_REPORTER
 * while SES is not set up; unset means all channels.
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
  emailSupervisorsChannel,
];

/**
 * The channels this deployment runs: those named in NOTIFICATION_CHANNELS, or
 * all of them when it is unset or empty. A name that matches no channel is an
 * error, because a typo would otherwise silently send nothing.
 */
export function selectChannels(
  setting: string | undefined = process.env.NOTIFICATION_CHANNELS,
): readonly NotificationChannel[] {
  const names = (setting ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return CHANNELS;

  const unknown = names.filter((n) => !CHANNELS.some((c) => c.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `NOTIFICATION_CHANNELS names an unknown channel: ${unknown.join(', ')}. ` +
        `Known channels: ${CHANNELS.map((c) => c.name).join(', ')}.`,
    );
  }
  return CHANNELS.filter((c) => names.includes(c.name));
}

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
  const channels = selectChannels().filter((c) => c.kinds.includes(event.kind));
  if (channels.length === 0) return;

  const ticket = await getTicket(event.ticketId);
  if (!ticket) {
    console.error('Ticket for notification not found', event);
    return;
  }

  // One failure must not hold back the rest: collect it, carry on, and throw
  // the first one at the end so the record is retried. What was sent is in the
  // notification log, so the retry skips it.
  const failures: unknown[] = [];
  const failed = (channel: NotificationChannel, err: unknown) => {
    failures.push(err);
    console.error('Notification channel failed', {
      ticketId: event.ticketId,
      eventId: event.eventId,
      channel: channel.name,
      err,
    });
  };

  for (const channel of channels) {
    let recipients: string[];
    try {
      recipients = await channel.recipients(ticket);
    } catch (err) {
      failed(channel, err);
      continue;
    }

    for (const recipient of recipients) {
      try {
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
      } catch (err) {
        failed(channel, err);
      }
    }
  }
  if (failures.length > 0) throw failures[0];
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
