import type { TicketRecord } from '../tickets/types.js';
import { responseMinutes, slaStartOf } from '../triage/policy.js';
import {
  formatBangkok,
  sesSender,
  type EmailSender,
} from './work-order-email.js';

/**
 * The alert for a ticket that missed an SLA target (SCFRMS-42, SLA-15, E1 and
 * E2 of requirements 3.7), sent by email to the supervisors: either the
 * resolution deadline passed (SLA_BREACHED, also the hourly reminders for a
 * CRITICAL ticket) or the response target passed with the ticket still ASSIGNED
 * (SLA_RESPONSE_BREACHED). It holds
 * what the requirements list: the ticket id, the location, the category, the
 * priority, how long it is overdue and the assigned team. It never holds the
 * reporter's LINE user id, and neither the description nor anything else the
 * resident wrote goes in the subject; the subject has only values the system
 * generated.
 */

/** "35 min", "2 h 5 min", "1 day", "3 days 4 h"; never negative. A length of time, not a moment. */
export function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'less than 1 min';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    const unit = days === 1 ? 'day' : 'days';
    return hours > 0 ? `${days} ${unit} ${hours} h` : `${days} ${unit}`;
  }
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

export type SlaAlertKind = 'SLA_BREACHED' | 'SLA_RESPONSE_BREACHED';

export function buildSlaBreachEmail(
  ticket: TicketRecord,
  now: Date,
  kind: SlaAlertKind = 'SLA_BREACHED',
  dashboardUrl?: string,
): { subject: string; text: string } {
  const { deadlineAt } = ticket;
  const team = ticket.teamId ?? 'UNASSIGNED';
  const priority = ticket.priority ?? 'UNKNOWN';

  const common = [
    `Ticket:    ${ticket.id}`,
    `Team:      ${team}`,
    `Priority:  ${priority}`,
    `Category:  ${ticket.category ?? 'UNKNOWN'}`,
    `Status:    ${ticket.status}`,
    `Location:  ${ticket.location}`,
  ];
  let subjectLabel: string;
  let lines: string[];

  if (kind === 'SLA_RESPONSE_BREACHED') {
    if (!ticket.priority) {
      throw new Error(`Ticket ${ticket.id} has no priority.`);
    }
    subjectLabel = 'SLA response';
    lines = [
      'A ticket has not been started within its response target.',
      '',
      ...common,
      `Response target: ${formatDuration(responseMinutes(ticket.priority) * 60_000)}`,
      `Waiting:   ${formatDuration(now.getTime() - Date.parse(slaStartOf(ticket)))}`,
      ...(deadlineAt
        ? [`Deadline:  ${formatBangkok(deadlineAt)} (Asia/Bangkok)`]
        : []),
    ];
  } else {
    if (!deadlineAt) throw new Error(`Ticket ${ticket.id} has no deadline.`);
    subjectLabel = 'SLA breach';
    lines = [
      'A ticket has passed its resolution deadline and is not done yet.',
      '',
      ...common,
      `Deadline:  ${formatBangkok(deadlineAt)} (Asia/Bangkok)`,
      `Overdue:   ${formatDuration(now.getTime() - Date.parse(deadlineAt))}`,
    ];
    const alerts = ticket.slaBreachAlerts ?? 1;
    if (alerts > 1) {
      lines.push(
        `Alert:     ${alerts} (a CRITICAL ticket is alerted every hour until it is done)`,
      );
    }
  }
  if (dashboardUrl) {
    lines.push(
      '',
      `View ticket: ${dashboardUrl.replace(/\/+$/, '')}/tickets/${ticket.id}`,
    );
  }

  return {
    subject: `[${subjectLabel}] ${priority} ticket ${ticket.id} - ${team}`,
    text: lines.join('\n') + '\n',
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set.`);
  return value;
}

/** Emails one supervisor about a missed SLA target. */
export async function sendSlaBreachEmail(
  ticket: TicketRecord,
  to: string,
  kind: SlaAlertKind = 'SLA_BREACHED',
  now: Date = new Date(),
  sender: EmailSender = sesSender,
): Promise<void> {
  const { subject, text } = buildSlaBreachEmail(
    ticket,
    now,
    kind,
    process.env.ADMIN_DASHBOARD_URL,
  );
  await sender.send({
    from: requiredEnv('SES_SENDER_EMAIL'),
    to,
    subject,
    text,
  });
}
