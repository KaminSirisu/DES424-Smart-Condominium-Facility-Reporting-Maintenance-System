import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';
import {
  buildWorkOrderEmail,
  formatBangkok,
  sendWorkOrderEmail,
  teamEmail,
} from '../../backend/src/notifications/work-order-email';
import type { EmailSender } from '../../backend/src/notifications/work-order-email';

function triaged(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Beside the lobby elevator',
    description: 'Water is leaking from the ceiling.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uabc123',
    category: 'PLUMBING',
    suggestedPriority: 'CRITICAL',
    priority: 'CRITICAL',
    teamId: 'PLUMBING',
    deadlineAt: '2026-10-29T07:00:00.000Z',
    createdAt: '2026-10-29T03:00:00.000Z',
    updatedAt: '2026-10-29T03:01:00.000Z',
    ...overrides,
  };
}

function fakeSender(): EmailSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe('formatBangkok', () => {
  it('shows Bangkok wall-clock time', () => {
    expect(formatBangkok('2026-10-29T07:00:00.000Z')).toBe('2026-10-29 14:00');
  });

  it('rolls over to the next day', () => {
    expect(formatBangkok('2026-10-29T18:30:00.000Z')).toBe('2026-10-30 01:30');
  });
});

describe('buildWorkOrderEmail', () => {
  it('lists the ticket details and the deadline', () => {
    const { subject, text } = buildWorkOrderEmail(triaged());
    expect(subject).toBe('[CRITICAL] Work order tkt_1 - PLUMBING');
    expect(text).toContain('assigned to the PLUMBING team');
    expect(text).toContain('Priority:  CRITICAL');
    expect(text).toContain('Location:  Beside the lobby elevator');
    expect(text).toContain('Reported:  2026-10-29 10:00 (Asia/Bangkok)');
    expect(text).toContain('Deadline:  2026-10-29 14:00 (Asia/Bangkok)');
    expect(text).toContain('Water is leaking from the ceiling.');
  });

  it('keeps resident-written text out of the subject', () => {
    const { subject } = buildWorkOrderEmail(
      triaged({ location: 'Lobby\r\nBcc: x@evil.test', description: 'a\nb' }),
    );
    expect(subject).not.toContain('Lobby');
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('adds a link only when a dashboard URL is set', () => {
    expect(buildWorkOrderEmail(triaged()).text).not.toContain('View ticket');
    expect(
      buildWorkOrderEmail(triaged(), 'https://admin.example.com/').text,
    ).toContain('View ticket: https://admin.example.com/tickets/tkt_1');
  });

  it('refuses a ticket that has not been triaged', () => {
    expect(() =>
      buildWorkOrderEmail(
        triaged({ teamId: undefined, deadlineAt: undefined }),
      ),
    ).toThrow('has not been triaged');
  });
});

describe('teamEmail', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the configured address for a team', () => {
    vi.stubEnv('TEAM_EMAILS', '{"PLUMBING":"plumbing@example.com"}');
    expect(teamEmail('PLUMBING')).toBe('plumbing@example.com');
  });

  it.each([
    ['unset', ''],
    ['missing the team', '{"HVAC":"hvac@example.com"}'],
    ['not an address', '{"PLUMBING":"nobody"}'],
    ['not a string', '{"PLUMBING":42}'],
  ])('returns null when TEAM_EMAILS is %s', (_label, value) => {
    vi.stubEnv('TEAM_EMAILS', value);
    expect(teamEmail('PLUMBING')).toBeNull();
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an array', '["a@b.c"]'],
  ])('throws when TEAM_EMAILS is %s', (_label, value) => {
    vi.stubEnv('TEAM_EMAILS', value);
    expect(() => teamEmail('PLUMBING')).toThrow('TEAM_EMAILS must be');
  });
});

describe('sendWorkOrderEmail', () => {
  beforeEach(() => {
    vi.stubEnv('TEAM_EMAILS', '{"PLUMBING":"plumbing@example.com"}');
    vi.stubEnv('SES_SENDER_EMAIL', 'noreply@example.com');
    vi.stubEnv('ADMIN_DASHBOARD_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends the work order to the team address', async () => {
    const sender = fakeSender();
    await expect(sendWorkOrderEmail(triaged(), sender)).resolves.toBe('SENT');

    expect(sender.send).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'plumbing@example.com',
      subject: '[CRITICAL] Work order tkt_1 - PLUMBING',
      text: expect.stringContaining('Ticket:    tkt_1'),
    });
  });

  it('reports NO_RECIPIENT instead of throwing when the team has no address', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('TEAM_EMAILS', '{}');
    const sender = fakeSender();

    await expect(sendWorkOrderEmail(triaged(), sender)).resolves.toBe(
      'NO_RECIPIENT',
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('fails clearly when the sender address is not configured', async () => {
    vi.stubEnv('SES_SENDER_EMAIL', '');
    await expect(sendWorkOrderEmail(triaged(), fakeSender())).rejects.toThrow(
      'SES_SENDER_EMAIL environment variable is not set.',
    );
  });

  it('rejects an unknown team id', async () => {
    const sender = fakeSender();
    await expect(
      sendWorkOrderEmail(triaged({ teamId: 'ROOFING' }), sender),
    ).rejects.toThrow('unknown team');
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('throws when SES fails so the caller can retry', async () => {
    const sender = fakeSender();
    sender.send.mockRejectedValue(new Error('throttled'));
    await expect(sendWorkOrderEmail(triaged(), sender)).rejects.toThrow(
      'throttled',
    );
  });
});
