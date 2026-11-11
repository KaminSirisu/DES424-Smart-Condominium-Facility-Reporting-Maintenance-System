import { listAccounts } from '../shared/account-management.js';
import type { AccountRecord } from '../shared/accounts.js';
import type { NotificationChannel } from './channel.js';
import { sendSlaBreachEmail } from './sla-breach-email.js';

/**
 * The SLA breach alert (SCFRMS-42): when the sweep records an SLA_BREACHED
 * event, every active MANAGER account gets an email (the "supervisor" and
 * "Juristic Manager" of requirements 3.7). The addresses are the managers'
 * login emails in the Accounts table, so adding, disabling or removing a
 * manager through the account endpoints changes who is alerted, with no
 * setting to keep in step.
 *
 * A deployment with no active manager has nobody to alert: that is logged and
 * is not an error, because a retry cannot fix it. The channel needs SES and
 * read access to the Accounts table; a deployment without them leaves it out
 * of NOTIFICATION_CHANNELS.
 */

/** The login emails of the active managers. */
export async function activeManagerEmails(
  list: () => Promise<AccountRecord[]> = listAccounts,
): Promise<string[]> {
  return (await list())
    .filter((a) => a.role === 'MANAGER' && a.isActive)
    .map((a) => a.username);
}

export const emailSupervisorsChannel: NotificationChannel = {
  name: 'EMAIL_SUPERVISORS',
  kinds: ['SLA_BREACHED'],
  recipients: async (ticket) => {
    const emails = await activeManagerEmails();
    if (emails.length === 0) {
      console.error('No active manager to alert about an SLA breach', {
        ticketId: ticket.id,
      });
    }
    return emails;
  },
  send: async (ticket, recipient) => {
    await sendSlaBreachEmail(ticket, recipient);
    return true;
  },
};
