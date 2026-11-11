import {
  listAllReceivedTickets,
  listOpenTickets,
  recordSlaAlert,
} from '../shared/ticket-repository.js';
import { triageQueueWindow } from '../tickets/triage-queue.js';
import type { TicketRecord } from '../tickets/types.js';
import { dueAlerts } from './alerts.js';

/**
 * The SLA safety net (SLA-13, SCFRMS-42): an EventBridge rule runs this every
 * 5 minutes. It reads the open tickets and the tickets still RECEIVED, works
 * out which SLA alerts each owes (sla/alerts.ts: the triage delay, the warning
 * at 75% of the resolution time, the response target missed, the deadline
 * passed and a CRITICAL ticket's hourly reminder)
 * and records each alert once (SLA-14): a mark on the ticket and an audit event,
 * in one transaction (shared/ticket-repository.ts). The notification worker
 * turns those events into emails.
 *
 * A failure on one alert never stops the others: every alert that can be
 * recorded is, and only then is the first error thrown, so the run is reported
 * as failed. Running again is safe: an alert that was recorded is no longer
 * owed, and two runs at once cannot record the same alert twice.
 */

export interface SweepResult {
  /** Open tickets and tickets waiting for triage looked at. */
  checked: number;
  /** Alerts this run recorded. */
  recorded: number;
}

export async function handler(now: Date = new Date()): Promise<SweepResult> {
  const open = await listOpenTickets();

  let recorded = 0;
  const failures: unknown[] = [];

  // A failing read of the RECEIVED tickets (they come from another index) must
  // not stop the alerts of the open ones: it is reported at the end instead.
  let waiting: TicketRecord[] = [];
  try {
    waiting = await listAllReceivedTickets(triageQueueWindow(now));
  } catch (err) {
    failures.push(err);
    console.error('Reading the tickets waiting for triage failed', { err });
  }

  const tickets = [...waiting, ...open];
  for (const ticket of tickets) {
    for (const alert of dueAlerts(ticket, now)) {
      try {
        if (await recordSlaAlert(ticket, alert, now)) recorded++;
      } catch (err) {
        failures.push(err);
        console.error('Recording an SLA alert failed', {
          ticketId: ticket.id,
          alert: alert.kind,
          err,
        });
      }
    }
  }

  console.info('SLA sweep done', { checked: tickets.length, recorded });
  if (failures.length > 0) throw failures[0];
  return { checked: tickets.length, recorded };
}
