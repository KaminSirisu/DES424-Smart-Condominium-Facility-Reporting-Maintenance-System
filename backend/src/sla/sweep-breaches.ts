import {
  listBreachedTickets,
  markSlaBreached,
} from '../shared/ticket-repository.js';

/**
 * The SLA safety net (SLA-13, SCFRMS-42): an EventBridge rule runs this every
 * 5 minutes. It finds open tickets whose resolution deadline has passed and
 * records each breach once (SLA-14): the escalation level on the ticket and an
 * SLA_BREACHED audit event, in one transaction (shared/ticket-repository.ts).
 * The notification worker turns that event into the alert email.
 *
 * A failure on one ticket never stops the others: every ticket that can be
 * recorded is, and only then is the first error thrown, so the run is reported
 * as failed. Running again is safe, because a breach that was recorded is no
 * longer found, and two runs at once cannot record the same breach twice.
 */

export interface SweepResult {
  /** Tickets found past their deadline without a recorded breach. */
  checked: number;
  /** Breaches this run recorded. */
  breached: number;
}

export async function handler(now: Date = new Date()): Promise<SweepResult> {
  const candidates = await listBreachedTickets(now);

  let breached = 0;
  const failures: unknown[] = [];
  for (const ticket of candidates) {
    try {
      if (await markSlaBreached(ticket, now)) breached++;
    } catch (err) {
      failures.push(err);
      console.error('Recording an SLA breach failed', {
        ticketId: ticket.id,
        err,
      });
    }
  }

  console.info('SLA sweep done', { checked: candidates.length, breached });
  if (failures.length > 0) throw failures[0];
  return { checked: candidates.length, breached };
}
