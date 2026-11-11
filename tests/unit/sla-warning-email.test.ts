import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';
import {
  buildSlaWarningEmail,
  sendSlaWarningEmail,
} from '../../backend/src/notifications/sla-warning-email';
import type { EmailSender } from '../../backend/src/notifications/work-order-email';

// 12:00 Bangkok, three hours before the deadline.
const NOW = new Date('2026-11-11T05:00:00.000Z');

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Beside the lobby elevator',
    description: 'Water is leaking. Call me on 0812345678.',
    status: 'IN_PROGRESS',
    repairCycle: 1,
    photos: [],
    version: 4,
    reporterLineUserId: 'Uabc123secret',
    category: 'PLUMBING',
    priority: 'MEDIUM',
    teamId: 'PLUMBING',
    deadlineAt: '2026-11-11T08:00:00.000Z',
    createdAt: '2026-10-29T20:00:00.000Z',
    updatedAt: '2026-11-11T02:00:00.000Z',
    ...overrides,
  };
}

function fakeSender(): EmailSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe('buildSlaWarningEmail', () => {
  it('holds what the team needs to act, and the time left', () => {
    const { subject, text } = buildSlaWarningEmail(ticket(), NOW);

    expect(subject).toBe('[SLA warning] MEDIUM ticket tkt_1 - PLUMBING');
    expect(text).toContain('has used 75% of its resolution time');
    expect(text).toContain('Ticket:    tkt_1');
    expect(text).toContain('Priority:  MEDIUM');
    expect(text).toContain('Category:  PLUMBING');
    expect(text).toContain('Status:    IN_PROGRESS');
    expect(text).toContain('Location:  Beside the lobby elevator');
    expect(text).toContain('Deadline:  2026-11-11 15:00 (Asia/Bangkok)');
    expect(text).toContain('Time left: 3 h');
    expect(text).not.toContain('View ticket');
  });

  it('never holds the reporter or the description', () => {
    const { subject, text } = buildSlaWarningEmail(ticket(), NOW);
    expect(text).not.toContain('Uabc123secret');
    expect(text).not.toContain('0812345678');
    expect(text).not.toContain('Water is leaking');
    expect(subject).not.toContain('lobby');
  });

  it('links to the ticket when the dashboard address is known', () => {
    expect(
      buildSlaWarningEmail(ticket(), NOW, 'https://admin.example.com/').text,
    ).toContain('View ticket: https://admin.example.com/tickets/tkt_1');
  });

  it('says UNKNOWN for what the ticket does not have, and refuses a ticket with no deadline', () => {
    const { subject, text } = buildSlaWarningEmail(
      ticket({ priority: undefined, category: undefined, teamId: undefined }),
      NOW,
    );
    expect(subject).toBe('[SLA warning] UNKNOWN ticket tkt_1 - UNASSIGNED');
    expect(text).toContain('Category:  UNKNOWN');
    expect(() =>
      buildSlaWarningEmail(ticket({ deadlineAt: undefined }), NOW),
    ).toThrow(/no deadline/);
  });
});

describe('sendSlaWarningEmail', () => {
  beforeEach(() => {
    vi.stubEnv('SES_SENDER_EMAIL', 'noreply@example.com');
    vi.stubEnv('ADMIN_DASHBOARD_URL', 'https://admin.example.com');
    vi.stubEnv('TEAM_EMAILS', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emails the team address from the Teams table', async () => {
    const sender = fakeSender();
    const lookup = vi.fn().mockResolvedValue('plumbing@example.com');

    await expect(
      sendSlaWarningEmail(ticket(), NOW, sender, lookup),
    ).resolves.toBe('SENT');

    expect(lookup).toHaveBeenCalledWith('PLUMBING');
    expect(sender.send).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'plumbing@example.com',
      subject: '[SLA warning] MEDIUM ticket tkt_1 - PLUMBING',
      text: expect.stringContaining(
        'View ticket: https://admin.example.com/tickets/tkt_1',
      ),
    });
  });

  it('falls back to TEAM_EMAILS when the Teams table has no address', async () => {
    vi.stubEnv('TEAM_EMAILS', JSON.stringify({ PLUMBING: 'env@example.com' }));
    const sender = fakeSender();
    await sendSlaWarningEmail(
      ticket(),
      NOW,
      sender,
      vi.fn().mockResolvedValue(null),
    );
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'env@example.com' }),
    );
  });

  it('reports NO_RECIPIENT, without sending, when the team has no address', async () => {
    const sender = fakeSender();
    await expect(
      sendSlaWarningEmail(
        ticket(),
        NOW,
        sender,
        vi.fn().mockResolvedValue(null),
      ),
    ).resolves.toBe('NO_RECIPIENT');
    expect(sender.send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'No email address configured for team',
      { ticketId: 'tkt_1', teamId: 'PLUMBING' },
    );
  });

  it('throws for a ticket with an unknown team or none, and when the lookup or SES fails', async () => {
    const sender = fakeSender();
    const lookup = vi.fn().mockResolvedValue('plumbing@example.com');
    await expect(
      sendSlaWarningEmail(ticket({ teamId: 'GARDEN' }), NOW, sender, lookup),
    ).rejects.toThrow(/unknown team/);
    await expect(
      sendSlaWarningEmail(ticket({ teamId: undefined }), NOW, sender, lookup),
    ).rejects.toThrow(/unknown team/);
    await expect(
      sendSlaWarningEmail(
        ticket(),
        NOW,
        sender,
        vi.fn().mockRejectedValue(new Error('throttled')),
      ),
    ).rejects.toThrow('throttled');
    sender.send.mockRejectedValue(new Error('ses'));
    await expect(
      sendSlaWarningEmail(ticket(), NOW, sender, lookup),
    ).rejects.toThrow('ses');
  });

  it('fails without a sender address', async () => {
    vi.stubEnv('SES_SENDER_EMAIL', '');
    const sender = fakeSender();
    await expect(
      sendSlaWarningEmail(
        ticket(),
        NOW,
        sender,
        vi.fn().mockResolvedValue('plumbing@example.com'),
      ),
    ).rejects.toThrow(/SES_SENDER_EMAIL/);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
