import {
  responseMinutes,
  SLA_REPEAT_MINUTES,
  SLA_WARNING_SHARE,
  slaStartOf,
} from '../triage/policy.js';
import type { SlaAlert, TicketRecord } from '../tickets/types.js';

/**
 * Which SLA alerts a ticket owes right now (requirements 3.7), worked out from
 * the ticket and the time alone, so the sweep and its tests need no database.
 * Only open tickets (ASSIGNED, IN_PROGRESS) owe anything; the clock stops at
 * DONE or MERGED (SLA-11). An alert already raised for the current SLA clock
 * (the `sla...` fields of the ticket) is not owed again.
 *
 *  - WARNING (E0): 75% of the resolution time, from the start of the SLA clock
 *    to `deadlineAt`, has been used and the deadline has not passed yet. A
 *    ticket first seen after its deadline gets the breach alert instead.
 *  - RESPONSE_BREACH (E1): the response target (policy.ts) has passed and the
 *    ticket is still ASSIGNED, work has not started.
 *  - RESOLUTION_BREACH (E2): `deadlineAt` has passed. After the first alert, a
 *    CRITICAL ticket is alerted again every SLA_REPEAT_MINUTES until it is
 *    done; any other priority is alerted once.
 *
 * The result is in time order of the clock, so the sweep records the earlier
 * alerts first.
 */
export function dueAlerts(ticket: TicketRecord, now: Date): SlaAlert[] {
  if (ticket.status !== 'ASSIGNED' && ticket.status !== 'IN_PROGRESS') {
    return [];
  }
  const deadline = Date.parse(ticket.deadlineAt ?? '');
  const start = Date.parse(slaStartOf(ticket));
  if (Number.isNaN(deadline) || Number.isNaN(start)) return [];

  const at = now.getTime();
  const alerts: SlaAlert[] = [];

  if (
    !ticket.slaWarnedAt &&
    at < deadline &&
    at >= start + SLA_WARNING_SHARE * (deadline - start)
  ) {
    alerts.push({ kind: 'WARNING' });
  }

  if (
    ticket.status === 'ASSIGNED' &&
    ticket.priority &&
    !ticket.slaResponseBreachedAt &&
    at >= start + responseMinutes(ticket.priority) * 60_000
  ) {
    alerts.push({ kind: 'RESPONSE_BREACH' });
  }

  if (at >= deadline) {
    if (!ticket.slaBreachedAt) {
      alerts.push({ kind: 'RESOLUTION_BREACH', sent: 0 });
    } else if (
      ticket.priority === 'CRITICAL' &&
      ticket.slaLastBreachAlertAt &&
      at >=
        Date.parse(ticket.slaLastBreachAlertAt) + SLA_REPEAT_MINUTES * 60_000
    ) {
      alerts.push({
        kind: 'RESOLUTION_BREACH',
        sent: ticket.slaBreachAlerts ?? 1,
      });
    }
  }
  return alerts;
}
