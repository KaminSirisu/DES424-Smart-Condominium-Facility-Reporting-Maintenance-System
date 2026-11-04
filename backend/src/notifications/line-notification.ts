import { proofPhotoUrl } from '../shared/proof-photo.js';
import { listReporterIds } from '../shared/ticket-reporters.js';
import type { TicketRecord } from '../tickets/types.js';
import type { NotificationChannel, NotificationEvent } from './channel.js';
import {
  buildAssignedMessage,
  buildCompletedMessage,
  buildReceiptMessage,
  buildStartedMessage,
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
 * notice; STATUS_CHANGED sends the work started notice (toStatus IN_PROGRESS)
 * or the completion notice (toStatus DONE, SCFRMS-43). The completion notice
 * shows the repair photo as a small copy with a signed URL (see
 * shared/proof-photo.ts); if that cannot be made the notice is sent without
 * the photo, because telling the reporter matters more than the picture.
 *
 * Environment: BUILDING_SECURITY_PHONE (shown on the receipt) and LIFF_URL
 * (the https://liff.line.me/<liffId> link that the buttons open); both are
 * optional. The channel access token is read in line-messenger.ts.
 */

export const LINE_KINDS = [
  'TICKET_CREATED',
  'TRIAGED',
  'STATUS_CHANGED',
] as const;

export function flexOptionsFromEnv(): FlexOptions {
  return {
    securityPhone: process.env.BUILDING_SECURITY_PHONE || undefined,
    liffUrl: process.env.LIFF_URL || undefined,
  };
}

function messageFor(
  event: NotificationEvent,
  ticket: TicketRecord,
  options: FlexOptions,
): LineMessage | null {
  if (event.kind === 'TICKET_CREATED') {
    return buildReceiptMessage(ticket, options);
  }
  if (event.kind === 'TRIAGED') return buildAssignedMessage(ticket, options);
  if (event.kind === 'STATUS_CHANGED') {
    if (event.toStatus === 'IN_PROGRESS') {
      return buildStartedMessage(ticket, options);
    }
    if (event.toStatus === 'DONE') {
      return buildCompletedMessage(ticket, options);
    }
  }
  return null;
}

/** The message options, plus the repair photo URL for a completion notice. */
async function optionsFor(
  deps: LineChannelDeps,
  ticket: TicketRecord,
  event: NotificationEvent,
): Promise<FlexOptions> {
  const options = deps.options();
  const isCompletion =
    event.kind === 'STATUS_CHANGED' && event.toStatus === 'DONE';
  if (!isCompletion || !event.proofPhotoId || !deps.proofPhotoUrl) {
    return options;
  }
  try {
    const url = await deps.proofPhotoUrl(ticket, event.proofPhotoId);
    return url ? { ...options, proofPhotoUrl: url } : options;
  } catch (err) {
    console.error('Proof photo link failed; sending without the photo', {
      ticketId: event.ticketId,
      eventId: event.eventId,
      err,
    });
    return options;
  }
}

export interface LineChannelDeps {
  sender: LineSender;
  listReporters: (ticketId: string) => Promise<string[]>;
  options: () => FlexOptions;
  /** A signed URL of the repair photo's small copy; without it no photo is shown. */
  proofPhotoUrl?: (
    ticket: TicketRecord,
    photoId: string,
  ) => Promise<string | null>;
}

export function createLineChannel(
  deps: LineChannelDeps = {
    sender: lineSender,
    listReporters: listReporterIds,
    options: flexOptionsFromEnv,
    proofPhotoUrl,
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
      const message = messageFor(
        event,
        ticket,
        await optionsFor(deps, ticket, event),
      );
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
