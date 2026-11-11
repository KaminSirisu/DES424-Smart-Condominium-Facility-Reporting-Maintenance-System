import {
  listOpenTickets,
  recordSlaAlert,
} from '../shared/ticket-repository.js';
import { dueAlerts } from './alerts.js';

/**
 * The SLA safety net (SLA-13, SCFRMS-42): an EventBridge rule runs this every
 * 5 minutes. It reads the open tickets, works out which SLA alerts each owes
 * (sla/alerts.ts: the warning at 75% of the resolution time, the response
 * target missed, the deadline passed and a CRITICAL ticket's hourly reminder)
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
  /** Open tickets looked at. */
  checked: number;
  /** Alerts this run recorded. */
  recorded: number;
}

export async function handler(now: Date = new Date()): Promise<SweepResult> {
  const tickets = await listOpenTickets();

  let recorded = 0;
  const failures: unknown[] = [];
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
