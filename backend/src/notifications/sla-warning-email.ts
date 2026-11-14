import { getTeamEmail } from '../shared/teams.js';
import type { TicketRecord } from '../tickets/types.js';
import { isTeamId } from '../triage/policy.js';
import { formatDuration } from './sla-breach-email.js';
import { staffTicketLink } from './staff-ticket-link.js';
import { ticketReference } from './ticket-reference.js';
import {
  formatBangkok,
  sesSender,
  teamEmail,
  type EmailSender,
} from './work-order-email.js';

/**
 * The SLA warning to the assigned team (SCFRMS-42, E0 of requirements 3.7): the
 * ticket has used 75% of its resolution time and is not done. It goes to the
 * team's work order address (the Teams table, then TEAM_EMAILS) and holds what
 * the team needs to act: ticket id, priority, category, location, status,
 * deadline and the time left. It never holds the reporter or the description,
 * and the subject has only values the system generated.
 */

export function buildSlaWarningEmail(
  ticket: TicketRecord,
  now: Date,
  dashboardUrl?: string,
): { subject: string; text: string } {
  const { deadlineAt } = ticket;
  if (!deadlineAt) throw new Error(`Ticket ${ticket.id} has no deadline.`);
  const team = ticket.teamId ?? 'UNASSIGNED';
  const priority = ticket.priority ?? 'UNKNOWN';

  const lines = [
    'A ticket of your team has used 75% of its resolution time and is not done yet.',
    '',
    `Ticket:    ${ticketReference(ticket.id)}`,
    `Priority:  ${priority}`,
    `Category:  ${ticket.category ?? 'UNKNOWN'}`,
    `Status:    ${ticket.status}`,
    `Location:  ${ticket.location}`,
    `Deadline:  ${formatBangkok(deadlineAt)} (Asia/Bangkok)`,
    `Time left: ${formatDuration(Date.parse(deadlineAt) - now.getTime())}`,
  ];
  if (dashboardUrl) {
    lines.push(
      '',
      `View ticket: ${staffTicketLink(dashboardUrl, ticket.id, 'TECHNICIAN')}`,
    );
  }

  return {
    subject: `[SLA warning] ${priority} ticket ${ticketReference(ticket.id)} - ${team}`,
    text: lines.join('\n') + '\n',
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set.`);
  return value;
}

export type SlaWarningResult = 'SENT' | 'NO_RECIPIENT';

/**
 * Emails the ticket's team. A team with no address is reported as
 * NO_RECIPIENT rather than thrown, because retrying cannot fix it; a failing
 * Teams lookup is thrown so the caller retries.
 */
export async function sendSlaWarningEmail(
  ticket: TicketRecord,
  now: Date = new Date(),
  sender: EmailSender = sesSender,
  lookupEmail: (teamId: string) => Promise<string | null> = getTeamEmail,
): Promise<SlaWarningResult> {
  const { subject, text } = buildSlaWarningEmail(
    ticket,
    now,
    process.env.ADMIN_DASHBOARD_URL,
  );
  const teamId = ticket.teamId;
  if (!teamId || !isTeamId(teamId)) {
    throw new Error(`Ticket ${ticket.id} has an unknown team.`);
  }

  const to = (await lookupEmail(teamId)) ?? teamEmail(teamId);
  if (!to) {
    console.error('No email address configured for team', {
      ticketId: ticket.id,
      teamId,
    });
    return 'NO_RECIPIENT';
  }

  await sender.send({
    from: requiredEnv('SES_SENDER_EMAIL'),
    to,
    subject,
    text,
  });
  return 'SENT';
}
