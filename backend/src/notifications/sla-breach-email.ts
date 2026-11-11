import type { TicketRecord } from '../tickets/types.js';
import {
  formatBangkok,
  sesSender,
  type EmailSender,
} from './work-order-email.js';

/**
 * The alert for a ticket that passed its resolution deadline (SCFRMS-42,
 * SLA-15, E2 of requirements 3.7), sent by email to the supervisors. It holds
 * what the requirements list: the ticket id, the location, the category, the
 * priority, how long it is overdue and the assigned team. It never holds the
 * reporter's LINE user id, and neither the description nor anything else the
 * resident wrote goes in the subject; the subject has only values the system
 * generated.
 */

/** "35 min", "2 h 5 min", "3 days 4 h"; never negative. */
export function formatOverdue(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'less than 1 min';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} days ${hours} h` : `${days} days`;
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

export function buildSlaBreachEmail(
  ticket: TicketRecord,
  now: Date,
  dashboardUrl?: string,
): { subject: string; text: string } {
  const { deadlineAt } = ticket;
  if (!deadlineAt) throw new Error(`Ticket ${ticket.id} has no deadline.`);
  const team = ticket.teamId ?? 'UNASSIGNED';
  const priority = ticket.priority ?? 'UNKNOWN';

  const lines = [
    'A ticket has passed its resolution deadline and is not done yet.',
    '',
    `Ticket:    ${ticket.id}`,
    `Team:      ${team}`,
    `Priority:  ${priority}`,
    `Category:  ${ticket.category ?? 'UNKNOWN'}`,
    `Status:    ${ticket.status}`,
    `Location:  ${ticket.location}`,
    `Deadline:  ${formatBangkok(deadlineAt)} (Asia/Bangkok)`,
    `Overdue:   ${formatOverdue(now.getTime() - Date.parse(deadlineAt))}`,
  ];
  if (dashboardUrl) {
    lines.push(
      '',
      `View ticket: ${dashboardUrl.replace(/\/+$/, '')}/tickets/${ticket.id}`,
    );
  }

  return {
    subject: `[SLA breach] ${priority} ticket ${ticket.id} - ${team}`,
    text: lines.join('\n') + '\n',
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set.`);
  return value;
}

/** Emails one supervisor about a breach. */
export async function sendSlaBreachEmail(
  ticket: TicketRecord,
  to: string,
  now: Date = new Date(),
  sender: EmailSender = sesSender,
): Promise<void> {
  const { subject, text } = buildSlaBreachEmail(
    ticket,
    now,
    process.env.ADMIN_DASHBOARD_URL,
  );
  await sender.send({
    from: requiredEnv('SES_SENDER_EMAIL'),
    to,
    subject,
    text,
  });
}
