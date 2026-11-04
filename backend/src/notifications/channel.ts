import type { TicketRecord } from '../tickets/types.js';

/**
 * A way of telling someone about a ticket change (SCFRMS-45/46). The
 * notification worker runs every channel whose `kinds` include the audit
 * event's kind, once per recipient.
 */

/** The audit event that triggered a notification. */
export interface NotificationEvent {
  ticketId: string;
  eventId: string;
  kind: string;
  /** The status a STATUS_CHANGED event moved the ticket to. */
  toStatus?: string;
  /** The REPAIR_PROOF photo that a DONE status change was made with. */
  proofPhotoId?: string;
}

export interface NotificationChannel {
  /** Used in logs and in the notification log, so never rename a channel once live. */
  name: string;
  /** Audit event kinds that trigger this channel. */
  kinds: readonly string[];
  /**
   * Who gets a message: one entry per message. The entry is stored in the
   * notification log, so a recipient is never messaged twice for one event,
   * but it must never be written to application logs.
   */
  recipients(ticket: TicketRecord): Promise<string[]>;
  /** Returns true if a message was actually sent. */
  send(
    ticket: TicketRecord,
    recipient: string,
    event: NotificationEvent,
  ): Promise<boolean>;
}
