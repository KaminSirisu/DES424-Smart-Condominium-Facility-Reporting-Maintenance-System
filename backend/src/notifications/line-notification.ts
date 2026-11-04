import { listReporterIds } from '../shared/ticket-reporters.js';
import type { TicketRecord } from '../tickets/types.js';
import type { NotificationChannel, NotificationEvent } from './channel.js';
import {
  buildAssignedMessage,
  buildReceiptMessage,
  type FlexOptions,
} from './line-flex.js';
import {
  LinePushError,
  lineSender,
  retryKeyFor,
  type LineMessage,
  type LineSender,
} from './line-messenger.js';

/**
 * LINE channel (SCFRMS-45): sends a Flex Message to every reporter of the
 * ticket. TICKET_CREATED sends the receipt; TRIAGED sends the assignment
 * notice. The completion notice joins when SCFRMS-43 writes the DONE event.
 *
 * Environment: BUILDING_SECURITY_PHONE (shown on the receipt) and LIFF_URL
 * (the https://liff.line.me/<liffId> link that the buttons open); both are
 * optional. The channel access token is read in line-messenger.ts.
 */

export const LINE_KINDS = ['TICKET_CREATED', 'TRIAGED'] as const;

export function flexOptionsFromEnv(): FlexOptions {
  return {
    securityPhone: process.env.BUILDING_SECURITY_PHONE || undefined,
    liffUrl: process.env.LIFF_URL || undefined,
  };
}

function messageFor(
  kind: string,
  ticket: TicketRecord,
  options: FlexOptions,
): LineMessage | null {
  if (kind === 'TICKET_CREATED') return buildReceiptMessage(ticket, options);
  if (kind === 'TRIAGED') return buildAssignedMessage(ticket, options);
  return null;
}

export interface LineChannelDeps {
  sender: LineSender;
  listReporters: (ticketId: string) => Promise<string[]>;
  options: () => FlexOptions;
}

export function createLineChannel(
  deps: LineChannelDeps = {
    sender: lineSender,
    listReporters: listReporterIds,
    options: flexOptionsFromEnv,
  },
): NotificationChannel {
  return {
    name: 'LINE_REPORTER',
    kinds: LINE_KINDS,
    recipients: (ticket) => deps.listReporters(ticket.id),
    async send(
      ticket: TicketRecord,
      lineUserId: string,
      event: NotificationEvent,
    ) {
      const message = messageFor(event.kind, ticket, deps.options());
      if (!message) return false;

      try {
        await deps.sender.push(
          lineUserId,
          [message],
          retryKeyFor(event.eventId, lineUserId),
        );
        return true;
      } catch (err) {
        // The user id is not logged (SR-35): only what LINE answered.
        if (err instanceof LinePushError && err.permanent) {
          console.error('LINE rejected a message; not retrying', {
            ticketId: event.ticketId,
            eventId: event.eventId,
            status: err.status,
          });
          return false;
        }
        throw err;
      }
    },
  };
}

export const lineReporterChannel = createLineChannel();
