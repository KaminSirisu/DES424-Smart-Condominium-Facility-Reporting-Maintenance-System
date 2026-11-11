import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../../backend/src/shared/accounts';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/account-management', () => ({
  listAccounts: vi.fn(),
}));
vi.mock('../../backend/src/notifications/sla-breach-email', () => ({
  sendSlaBreachEmail: vi.fn(),
}));

import {
  activeManagerEmails,
  emailSupervisorsChannel,
} from '../../backend/src/notifications/sla-breach-notification';
import { listAccounts } from '../../backend/src/shared/account-management';
import { sendSlaBreachEmail } from '../../backend/src/notifications/sla-breach-email';

const account = (
  username: string,
  role: 'MANAGER' | 'TECHNICIAN',
  isActive = true,
): AccountRecord => ({
  accountId: username,
  username,
  role,
  ...(role === 'TECHNICIAN' ? { teamId: 'PLUMBING' } : {}),
  displayName: username,
  passwordHash: '$2b$12$hash',
  isActive,
  tokenVersion: 0,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

const ticket = { id: 'tkt_1' } as TicketRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('activeManagerEmails', () => {
  it('lists the login emails of the active managers only', async () => {
    const emails = await activeManagerEmails(async () => [
      account('boss@example.com', 'MANAGER'),
      account('away@example.com', 'MANAGER', false),
      account('plumbing@example.com', 'TECHNICIAN'),
      account('deputy@example.com', 'MANAGER'),
    ]);
    expect(emails).toEqual(['boss@example.com', 'deputy@example.com']);
  });
});

describe('the supervisors channel', () => {
  it('answers SLA_BREACHED and nothing else', () => {
    expect(emailSupervisorsChannel.name).toBe('EMAIL_SUPERVISORS');
    expect(emailSupervisorsChannel.kinds).toEqual(['SLA_BREACHED']);
  });

  it('alerts the active managers read from the Accounts table', async () => {
    vi.mocked(listAccounts).mockResolvedValue([
      account('boss@example.com', 'MANAGER'),
      account('plumbing@example.com', 'TECHNICIAN'),
    ]);
    await expect(emailSupervisorsChannel.recipients(ticket)).resolves.toEqual([
      'boss@example.com',
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs, without an error, when there is no active manager to alert', async () => {
    vi.mocked(listAccounts).mockResolvedValue([
      account('away@example.com', 'MANAGER', false),
    ]);
    await expect(emailSupervisorsChannel.recipients(ticket)).resolves.toEqual(
      [],
    );
    expect(console.error).toHaveBeenCalledWith(
      'No active manager to alert about an SLA breach',
      { ticketId: 'tkt_1' },
    );
  });

  it('lets a failing Accounts read fail so the record is retried', async () => {
    vi.mocked(listAccounts).mockRejectedValue(new Error('throttled'));
    await expect(emailSupervisorsChannel.recipients(ticket)).rejects.toThrow(
      'throttled',
    );
  });

  it('sends the email to the recipient and says it was sent', async () => {
    vi.mocked(sendSlaBreachEmail).mockResolvedValue(undefined);
    await expect(
      emailSupervisorsChannel.send(ticket, 'boss@example.com', {
        ticketId: 'tkt_1',
        eventId: 'e1',
        kind: 'SLA_BREACHED',
      }),
    ).resolves.toBe(true);
    expect(sendSlaBreachEmail).toHaveBeenCalledWith(ticket, 'boss@example.com');
  });

  it('lets an email failure through so the record is retried', async () => {
    vi.mocked(sendSlaBreachEmail).mockRejectedValue(new Error('ses'));
    await expect(
      emailSupervisorsChannel.send(ticket, 'boss@example.com', {
        ticketId: 'tkt_1',
        eventId: 'e1',
        kind: 'SLA_BREACHED',
      }),
    ).rejects.toThrow('ses');
  });
});
