import { describe, expect, it } from 'vitest';
import { toTicketView } from '../../backend/src/tickets/ticket-view';
import type { TicketRecord } from '../../backend/src/tickets/types';

const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'IN_PROGRESS',
  repairCycle: 1,
  photos: [
    {
      id: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-10-28T10:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
    },
  ],
  version: 4,
  reporterLineUserId: 'Uabc123',
  category: 'PLUMBING',
  suggestedPriority: 'MEDIUM',
  priority: 'CRITICAL',
  prioritySetBy: 'AI',
  safetyHazard: 'GAS',
  teamId: 'PLUMBING',
  deadlineAt: '2026-10-28T14:00:00.000Z',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T11:30:00.000Z',
};

describe('toTicketView', () => {
  it('returns the fields of the Ticket schema', () => {
    expect(toTicketView(ticket)).toEqual({
      id: 'tkt_1',
      location: 'Lobby',
      description: 'Water is leaking.',
      status: 'IN_PROGRESS',
      repairCycle: 1,
      category: 'PLUMBING',
      suggestedPriority: 'MEDIUM',
      priority: 'CRITICAL',
      prioritySetBy: 'AI',
      teamId: 'PLUMBING',
      deadlineAt: '2026-10-28T14:00:00.000Z',
      createdAt: '2026-10-28T10:00:00.000Z',
      updatedAt: '2026-10-28T11:30:00.000Z',
      photos: [
        { id: 'upl_1', purpose: 'DEFECT', addedAt: '2026-10-28T10:00:00.000Z' },
      ],
    });
  });

  it('never exposes an internal field', () => {
    const view = toTicketView(ticket);
    for (const field of ['reporterLineUserId', 'version', 'safetyHazard']) {
      expect(view).not.toHaveProperty(field);
    }
    expect(JSON.stringify(view)).not.toContain('Uabc123');
    expect(JSON.stringify(view)).not.toContain('uploads/');
    expect(JSON.stringify(view)).not.toContain('s3ObjectKey');
  });

  it('leaves out fields a ticket does not have yet', () => {
    const fresh: TicketRecord = {
      id: 'tkt_2',
      location: 'Pool',
      description: 'Broken tile',
      status: 'RECEIVED',
      repairCycle: 1,
      photos: [],
      version: 1,
      reporterLineUserId: 'Uabc123',
      createdAt: 'c',
      updatedAt: 'u',
    };
    expect(toTicketView(fresh)).toEqual({
      id: 'tkt_2',
      location: 'Pool',
      description: 'Broken tile',
      status: 'RECEIVED',
      repairCycle: 1,
      createdAt: 'c',
      updatedAt: 'u',
      photos: [],
    });
  });

  it('keeps the repair cycle on a repair proof photo', () => {
    const view = toTicketView({
      ...ticket,
      photos: [
        {
          id: 'upl_9',
          purpose: 'REPAIR_PROOF',
          addedAt: 'x',
          repairCycle: 2,
          s3ObjectKey: 'uploads/REPAIR_PROOF/acct/upl_9',
        },
      ],
    });
    expect(view.photos).toEqual([
      { id: 'upl_9', purpose: 'REPAIR_PROOF', addedAt: 'x', repairCycle: 2 },
    ]);
  });
});
