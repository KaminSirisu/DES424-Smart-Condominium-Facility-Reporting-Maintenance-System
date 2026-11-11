import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';
import {
  buildSlaBreachEmail,
  formatDuration,
  sendSlaBreachEmail,
} from '../../backend/src/notifications/sla-breach-email';
import type { EmailSender } from '../../backend/src/notifications/work-order-email';

const MIN = 60_000;
const NOW = new Date('2026-11-11T10:35:00.000Z');

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Beside the lobby elevator',
    description: 'Water is leaking from the ceiling. Call me on 0812345678.',
    status: 'IN_PROGRESS',
    repairCycle: 1,
    photos: [],
    version: 4,
    reporterLineUserId: 'Uabc123secret',
    category: 'PLUMBING',
    priority: 'CRITICAL',
    teamId: 'PLUMBING',
    deadlineAt: '2026-11-11T08:30:00.000Z',
    createdAt: '2026-11-11T05:30:00.000Z',
    updatedAt: '2026-11-11T06:00:00.000Z',
    ...overrides,
  };
}

describe('formatDuration', () => {
  it.each([
    [0, 'less than 1 min'],
    [59_999, 'less than 1 min'],
    [-5 * MIN, 'less than 1 min'],
    [MIN, '1 min'],
    [35 * MIN, '35 min'],
    [60 * MIN, '1 h'],
    [125 * MIN, '2 h 5 min'],
    [1439 * MIN, '23 h 59 min'],
    [24 * 60 * MIN, '1 day'],
    [48 * 60 * MIN, '2 days'],
    [(24 * 60 + 3 * 60) * MIN, '1 day 3 h'],
    [(3 * 24 * 60 + 4 * 60 + 20) * MIN, '3 days 4 h'],
  ])('shows %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('buildSlaBreachEmail', () => {
  it('holds the ticket, team, priority, category, location, deadline and time overdue', () => {
    const { subject, text } = buildSlaBreachEmail(ticket(), NOW);

    expect(subject).toBe('[SLA breach] CRITICAL ticket tkt_1 - PLUMBING');
    expect(text).toContain('Ticket:    tkt_1');
    expect(text).toContain('Team:      PLUMBING');
    expect(text).toContain('Priority:  CRITICAL');
    expect(text).toContain('Category:  PLUMBING');
    expect(text).toContain('Status:    IN_PROGRESS');
    expect(text).toContain('Location:  Beside the lobby elevator');
    expect(text).toContain('Deadline:  2026-11-11 15:30 (Asia/Bangkok)');
    expect(text).toContain('Overdue:   2 h 5 min');
    expect(text).not.toContain('View ticket');
  });

  it('never holds the reporter, the description or anything a resident wrote in the subject', () => {
    const { subject, text } = buildSlaBreachEmail(ticket(), NOW);
    expect(text).not.toContain('Uabc123secret');
    expect(text).not.toContain('0812345678');
    expect(text).not.toContain('Water is leaking');
    expect(subject).not.toContain('lobby');
  });

  it('links to the ticket when the dashboard address is known', () => {
    const { text } = buildSlaBreachEmail(
      ticket(),
      NOW,
      'SLA_BREACHED',
      'https://admin.example.com/',
    );
    expect(text).toContain(
      'View ticket: https://admin.example.com/tickets/tkt_1',
    );
  });

  it('says UNASSIGNED and UNKNOWN for what the ticket does not have', () => {
    const { subject, text } = buildSlaBreachEmail(
      ticket({ teamId: undefined, priority: undefined, category: undefined }),
      NOW,
    );
    expect(subject).toBe('[SLA breach] UNKNOWN ticket tkt_1 - UNASSIGNED');
    expect(text).toContain('Category:  UNKNOWN');
  });

  it('refuses a ticket with no deadline', () => {
    expect(() =>
      buildSlaBreachEmail(ticket({ deadlineAt: undefined }), NOW),
    ).toThrow(/no deadline/);
  });
});

describe('buildSlaBreachEmail for a reminder', () => {
  it('says which alert it is once a CRITICAL ticket has had more than one', () => {
    const first = buildSlaBreachEmail(ticket({ slaBreachAlerts: 1 }), NOW).text;
    expect(first).not.toContain('Alert:');
    expect(buildSlaBreachEmail(ticket(), NOW).text).not.toContain('Alert:');
    const third = buildSlaBreachEmail(ticket({ slaBreachAlerts: 3 }), NOW).text;
    expect(third).toContain(
      'Alert:     3 (a CRITICAL ticket is alerted every hour until it is done)',
    );
  });
});

describe('buildSlaBreachEmail for a missed response target', () => {
  // A MEDIUM ticket started its clock at 08:30 Bangkok (01:30 UTC): target 2 h.
  const waiting = (overrides: Partial<TicketRecord> = {}) =>
    ticket({
      status: 'ASSIGNED',
      priority: 'MEDIUM',
      createdAt: '2026-11-11T05:30:00.000Z',
      deadlineAt: '2026-11-11T17:30:00.000Z',
      ...overrides,
    });

  it('names the target and how long the ticket has waited', () => {
    const { subject, text } = buildSlaBreachEmail(
      waiting(),
      NOW,
      'SLA_RESPONSE_BREACHED',
    );
    expect(subject).toBe('[SLA response] MEDIUM ticket tkt_1 - PLUMBING');
    expect(text).toContain(
      'A ticket has not been started within its response target.',
    );
    expect(text).toContain('Response target: 2 h');
    expect(text).toContain('Waiting:   5 h 5 min');
    expect(text).toContain('Status:    ASSIGNED');
    expect(text).toContain('Deadline:  2026-11-12 00:30 (Asia/Bangkok)');
    expect(text).not.toContain('Overdue:');
  });

  it('uses the response target of the priority: 15 minutes, 2 hours, 24 hours', () => {
    const at = (priority: 'CRITICAL' | 'LOW') =>
      buildSlaBreachEmail(waiting({ priority }), NOW, 'SLA_RESPONSE_BREACHED')
        .text;
    expect(at('CRITICAL')).toContain('Response target: 15 min');
    expect(at('LOW')).toContain('Response target: 1 day');
  });

  it('counts the wait from the start of the current SLA clock', () => {
    const { text } = buildSlaBreachEmail(
      waiting({ slaStartAt: '2026-11-11T09:00:00.000Z' }),
      NOW,
      'SLA_RESPONSE_BREACHED',
    );
    expect(text).toContain('Waiting:   1 h 35 min');
  });

  it('leaves out the deadline when there is none, and never has the reporter or the description', () => {
    const { text } = buildSlaBreachEmail(
      waiting({ deadlineAt: undefined }),
      NOW,
      'SLA_RESPONSE_BREACHED',
    );
    expect(text).not.toContain('Deadline:');
    expect(text).not.toContain('Uabc123secret');
    expect(text).not.toContain('Water is leaking');
  });

  it('links to the ticket when the dashboard address is known', () => {
    const { text } = buildSlaBreachEmail(
      waiting(),
      NOW,
      'SLA_RESPONSE_BREACHED',
      'https://admin.example.com',
    );
    expect(text).toContain(
      'View ticket: https://admin.example.com/tickets/tkt_1',
    );
  });

  it('needs a priority to know the target', () => {
    expect(() =>
      buildSlaBreachEmail(
        waiting({ priority: undefined }),
        NOW,
        'SLA_RESPONSE_BREACHED',
      ),
    ).toThrow(/no priority/);
  });
});

describe('sendSlaBreachEmail', () => {
  beforeEach(() => {
    vi.stubEnv('SES_SENDER_EMAIL', 'noreply@example.com');
    vi.stubEnv('ADMIN_DASHBOARD_URL', 'https://admin.example.com');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends one email to one supervisor with the sender address', async () => {
    const sender: EmailSender & { send: ReturnType<typeof vi.fn> } = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    await sendSlaBreachEmail(
      ticket(),
      'boss@example.com',
      'SLA_BREACHED',
      NOW,
      sender,
    );

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'boss@example.com',
      subject: '[SLA breach] CRITICAL ticket tkt_1 - PLUMBING',
      text: expect.stringContaining(
        'View ticket: https://admin.example.com/tickets/tkt_1',
      ),
    });
  });

  it('fails without a sender address, and passes on an SES error', async () => {
    const sender: EmailSender = {
      send: vi.fn().mockRejectedValue(new Error('ses')),
    };
    vi.stubEnv('SES_SENDER_EMAIL', '');
    await expect(
      sendSlaBreachEmail(
        ticket(),
        'boss@example.com',
        'SLA_BREACHED',
        NOW,
        sender,
      ),
    ).rejects.toThrow(/SES_SENDER_EMAIL/);
    expect(sender.send).not.toHaveBeenCalled();

    vi.stubEnv('SES_SENDER_EMAIL', 'noreply@example.com');
    await expect(
      sendSlaBreachEmail(
        ticket(),
        'boss@example.com',
        'SLA_BREACHED',
        NOW,
        sender,
      ),
    ).rejects.toThrow('ses');
  });
});
