import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  applyTriage: vi.fn(),
}));

import {
  TriageError,
  applyClassification,
} from '../../backend/src/triage/apply-classification';
import {
  applyTriage,
  getTicket,
} from '../../backend/src/shared/ticket-repository';

const NOW = new Date('2026-10-28T10:30:00.000Z');

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'RECEIVED',
    repairCycle: 1,
    photos: [],
    version: 1,
    reporterLineUserId: 'Uabc123',
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

const good = { category: 'PLUMBING', impact: 'HIGH', urgency: 'MEDIUM' };

describe('applyClassification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(applyTriage).mockResolvedValue(undefined);
  });

  it('computes priority, team and deadline in code and stores them', async () => {
    await expect(applyClassification('tkt_1', good, NOW)).resolves.toBe(
      'APPLIED',
    );

    expect(applyTriage).toHaveBeenCalledWith('tkt_1', 1, {
      category: 'PLUMBING',
      suggestedPriority: 'CRITICAL',
      priority: 'CRITICAL',
      teamId: 'PLUMBING',
      // 4h SLA counted from created_at, not from the triage time
      deadlineAt: '2026-10-28T14:00:00.000Z',
      slaPolicyVersion: 1,
      now: '2026-10-28T10:30:00.000Z',
    });
  });

  it('passes the version it read so a concurrent change is rejected', async () => {
    vi.mocked(getTicket).mockResolvedValue(ticket({ version: 4 }));
    await applyClassification('tkt_1', good, NOW);
    expect(vi.mocked(applyTriage).mock.calls[0][1]).toBe(4);
  });

  it('ignores any priority or team the model tries to supply', async () => {
    await applyClassification(
      'tkt_1',
      {
        category: 'HVAC',
        impact: 'LOW',
        urgency: 'LOW',
        priority: 'CRITICAL',
        teamId: 'ELECTRICAL',
      },
      NOW,
    );
    const update = vi.mocked(applyTriage).mock.calls[0][2];
    expect(update.priority).toBe('LOW');
    expect(update.teamId).toBe('HVAC');
  });

  it.each([
    ['null', null],
    ['a string', 'PLUMBING'],
    ['an unknown category', { ...good, category: 'ROOFING' }],
    ['a lower-case category', { ...good, category: 'plumbing' }],
    ['a missing impact', { category: 'PLUMBING', urgency: 'LOW' }],
    ['an unknown urgency', { ...good, urgency: 'URGENT' }],
    ['a priority in place of a level', { ...good, impact: 'CRITICAL' }],
  ])('rejects %s and leaves the ticket untouched', async (_label, value) => {
    await expect(
      applyClassification('tkt_1', value, NOW),
    ).rejects.toMatchObject({
      name: 'TriageError',
      code: 'INVALID_CLASSIFICATION',
    });
    expect(applyTriage).not.toHaveBeenCalled();
  });

  it('throws TICKET_NOT_FOUND for an unknown ticket', async () => {
    vi.mocked(getTicket).mockResolvedValue(null);
    await expect(applyClassification('tkt_x', good, NOW)).rejects.toMatchObject(
      { code: 'TICKET_NOT_FOUND' },
    );
    expect(applyTriage).not.toHaveBeenCalled();
  });

  it('does nothing for a ticket that is no longer RECEIVED', async () => {
    vi.mocked(getTicket).mockResolvedValue(ticket({ status: 'ASSIGNED' }));
    await expect(applyClassification('tkt_1', good, NOW)).resolves.toBe(
      'ALREADY_TRIAGED',
    );
    expect(applyTriage).not.toHaveBeenCalled();
  });

  it('treats a lost write race as already triaged', async () => {
    vi.mocked(applyTriage).mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ],
      }),
    );
    await expect(applyClassification('tkt_1', good, NOW)).resolves.toBe(
      'ALREADY_TRIAGED',
    );
  });

  it('rethrows other write failures so the caller can retry', async () => {
    vi.mocked(applyTriage).mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ProvisionedThroughputExceeded' },
          { Code: 'None' },
        ],
      }),
    );
    await expect(applyClassification('tkt_1', good, NOW)).rejects.toThrow(
      'cancelled',
    );
  });

  it('exposes TriageError as an Error subclass', () => {
    const err = new TriageError('TICKET_NOT_FOUND', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('TICKET_NOT_FOUND');
  });
});
