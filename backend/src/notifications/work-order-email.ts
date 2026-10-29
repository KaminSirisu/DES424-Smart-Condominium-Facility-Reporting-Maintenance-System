import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { TicketRecord } from '../tickets/types';
import { isTeamId } from '../triage/policy';

/**
 * Work order email to the assigned maintenance team (SCFRMS-46).
 *
 * Sent after AI triage has assigned the ticket. The team's address comes from
 * the TEAM_EMAILS environment variable, a JSON object such as
 * {"PLUMBING": "plumbing@example.com"}, because teams have no record in the
 * database yet. The email is plain text and the subject holds only values the
 * system generated (ticket id, priority, team), never resident-written text.
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

/** The address configured for a team, or null if there is none. */
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
    `Ticket:    ${ticket.id}`,
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
      `View ticket: ${dashboardUrl.replace(/\/+$/, '')}/tickets/${ticket.id}`,
    );
  }

  return {
    subject: `[${priority}] Work order ${ticket.id} - ${teamId}`,
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
 * Emails the ticket's team. A team with no configured address is reported as
 * NO_RECIPIENT rather than thrown, because retrying cannot fix it.
 */
export async function sendWorkOrderEmail(
  ticket: TicketRecord,
  sender: EmailSender = sesSender,
): Promise<WorkOrderResult> {
  const { subject, text } = buildWorkOrderEmail(
    ticket,
    process.env.ADMIN_DASHBOARD_URL,
  );
  const teamId = ticket.teamId;
  if (!teamId || !isTeamId(teamId)) {
    throw new Error(`Ticket ${ticket.id} has an unknown team.`);
  }

  const to = teamEmail(teamId);
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
