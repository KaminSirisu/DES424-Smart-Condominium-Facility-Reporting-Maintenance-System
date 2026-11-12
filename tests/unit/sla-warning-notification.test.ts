import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/notifications/sla-warning-email', () => ({
  sendSlaWarningEmail: vi.fn(),
}));

import { emailTeamWarningChannel } from '../../backend/src/notifications/sla-warning-notification';
import { sendSlaWarningEmail } from '../../backend/src/notifications/sla-warning-email';

const ticket = { id: 'tkt_1', teamId: 'PLUMBING' } as TicketRecord;
const event = { ticketId: 'tkt_1', eventId: 'e1', kind: 'SLA_WARNING' };

beforeEach(() => vi.resetAllMocks());

describe('the team warning channel', () => {
  it('answers SLA_WARNING and nothing else', () => {
    expect(emailTeamWarningChannel.name).toBe('EMAIL_TEAM_WARNING');
    expect(emailTeamWarningChannel.kinds).toEqual(['SLA_WARNING']);
  });

  it('has one recipient, the team that holds the ticket', async () => {
    await expect(emailTeamWarningChannel.recipients(ticket)).resolves.toEqual([
      'PLUMBING',
    ]);
    await expect(
      emailTeamWarningChannel.recipients({ id: 'tkt_2' } as TicketRecord),
    ).resolves.toEqual(['UNASSIGNED']);
  });

  it('says it sent the email only when it was sent', async () => {
    vi.mocked(sendSlaWarningEmail).mockResolvedValue('SENT');
    await expect(
      emailTeamWarningChannel.send(ticket, 'PLUMBING', event),
    ).resolves.toBe(true);
    expect(sendSlaWarningEmail).toHaveBeenCalledWith(ticket);

    vi.mocked(sendSlaWarningEmail).mockResolvedValue('NO_RECIPIENT');
    await expect(
      emailTeamWarningChannel.send(ticket, 'PLUMBING', event),
    ).resolves.toBe(false);
  });

  it('lets an email failure through so the record is retried', async () => {
    vi.mocked(sendSlaWarningEmail).mockRejectedValue(new Error('ses'));
    await expect(
      emailTeamWarningChannel.send(ticket, 'PLUMBING', event),
    ).rejects.toThrow('ses');
  });
});
