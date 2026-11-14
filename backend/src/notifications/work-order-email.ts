import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getTeamEmail } from '../shared/teams.js';
import type { TicketRecord } from '../tickets/types.js';
import { isTeamId } from '../triage/policy.js';
import { staffTicketLink } from './staff-ticket-link.js';
import { ticketReference } from './ticket-reference.js';

/**
 * Work order email to the assigned maintenance team (SCFRMS-46).
 *
 * Sent after AI triage has assigned the ticket. The team's address is the
 * `email` field of its record in the Teams table (shared/teams.ts). Until that
 * table exists, the TEAM_EMAILS environment variable is the fallback: a JSON
 * object such as {"PLUMBING": "plumbing@example.com"}. The email is plain text
 * and the subject holds only values the system generated (ticket id,
 * priority, team), never resident-written text.
 */

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** The SES call, behind an interface so tests need no AWS access. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

let ses: SESv2Client | undefined;

/** Client is created on first use, so importing this module needs no AWS setup. */
export const sesSender: EmailSender = {
  async send(message) {
    ses ??= new SESv2Client({ region: process.env.AWS_REGION });
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  },
};

export type WorkOrderResult = 'SENT' | 'NO_RECIPIENT';

/** The address configured for a team in TEAM_EMAILS, or null if there is none. */
export function teamEmail(teamId: string): string | null {
  const raw = process.env.TEAM_EMAILS;
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TEAM_EMAILS must be a JSON object of team id to email.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TEAM_EMAILS must be a JSON object of team id to email.');
  }
  const address = (parsed as Record<string, unknown>)[teamId];
  return typeof address === 'string' && address.includes('@') ? address : null;
}

/** Bangkok wall-clock time, e.g. "2026-10-29 14:00". */
export function formatBangkok(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function buildWorkOrderEmail(
  ticket: TicketRecord,
  dashboardUrl?: string,
): { subject: string; text: string } {
  const { teamId, priority, category, deadlineAt } = ticket;
  if (!teamId || !priority || !category || !deadlineAt) {
    throw new Error(`Ticket ${ticket.id} has not been triaged.`);
  }

  const lines = [
    `A new work order has been assigned to the ${teamId} team.`,
    '',
    `Ticket:    ${ticketReference(ticket.id)}`,
    `Priority:  ${priority}`,
    `Category:  ${category}`,
    `Location:  ${ticket.location}`,
    `Reported:  ${formatBangkok(ticket.createdAt)} (Asia/Bangkok)`,
    `Deadline:  ${formatBangkok(deadlineAt)} (Asia/Bangkok)`,
    '',
    'Description:',
    ticket.description,
  ];
  if (dashboardUrl) {
    lines.push(
      '',
      `View ticket: ${staffTicketLink(dashboardUrl, ticket.id, 'TECHNICIAN')}`,
    );
  }

  return {
    subject: `[${priority}] Work order ${ticketReference(ticket.id)} - ${teamId}`,
    text: lines.join('\n') + '\n',
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }
  return value;
}

/**
 * Emails the ticket's team. A team with no address in the Teams table or in
 * TEAM_EMAILS is reported as NO_RECIPIENT rather than thrown, because
 * retrying cannot fix it. A failing Teams lookup is thrown so the caller
 * retries.
 */
export async function sendWorkOrderEmail(
  ticket: TicketRecord,
  sender: EmailSender = sesSender,
  lookupEmail: (teamId: string) => Promise<string | null> = getTeamEmail,
): Promise<WorkOrderResult> {
  const { subject, text } = buildWorkOrderEmail(
    ticket,
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
