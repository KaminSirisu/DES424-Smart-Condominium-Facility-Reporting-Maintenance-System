import type { NotificationChannel } from './channel.js';
import { sendSlaWarningEmail } from './sla-warning-email.js';

/**
 * The SLA warning (SCFRMS-42, E0): when the sweep records an SLA_WARNING event,
 * the team that holds the ticket gets an email at its work order address. One
 * recipient, the team, so the notification log keeps it from being sent twice
 * for one event. A deployment without SES leaves the channel out of
 * NOTIFICATION_CHANNELS.
 */
export const emailTeamWarningChannel: NotificationChannel = {
  name: 'EMAIL_TEAM_WARNING',
  kinds: ['SLA_WARNING'],
  recipients: async (ticket) => [ticket.teamId ?? 'UNASSIGNED'],
  send: async (ticket) => (await sendSlaWarningEmail(ticket)) === 'SENT',
};
