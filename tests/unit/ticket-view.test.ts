import { describe, expect, it } from 'vitest';
import { toTicketView } from '../../backend/src/tickets/ticket-view';
import type { TicketRecord } from '../../backend/src/tickets/types';

const accepted: TicketRecord = {
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
  acceptedByStaffId: 'acct_plumbing',
  acceptedAt: '2026-10-28T11:00:00.000Z',
  deadlineAt: '2026-10-28T14:00:00.000Z',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T11:30:00.000Z',
};

const visibleToEveryone = {
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
  acceptedAt: '2026-10-28T11:00:00.000Z',
  deadlineAt: '2026-10-28T14:00:00.000Z',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T11:30:00.000Z',
  photos: [
    { id: 'upl_1', purpose: 'DEFECT', addedAt: '2026-10-28T10:00:00.000Z' },
  ],
};

describe('toTicketView', () => {
  it('shows a reporter everything except the accepting staff account', () => {
    expect(toTicketView(accepted, 'REPORTER')).toEqual(visibleToEveryone);
  });

  it('shows staff the accepting staff account as well', () => {
    expect(toTicketView(accepted, 'STAFF')).toEqual({
      ...visibleToEveryone,
      acceptedByStaffId: 'acct_plumbing',
    });
  });

  it.each(['REPORTER', 'STAFF'] as const)(
    'never exposes an internal field to %s',
    (audience) => {
      const view = toTicketView(accepted, audience);
      for (const field of ['reporterLineUserId', 'version', 'safetyHazard']) {
        expect(view).not.toHaveProperty(field);
      }
      expect(JSON.stringify(view)).not.toContain('Uabc123');
      expect(JSON.stringify(view)).not.toContain('uploads/');
      expect(JSON.stringify(view)).not.toContain('s3ObjectKey');
    },
  );

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
    expect(toTicketView(fresh, 'STAFF')).toEqual({
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
    const view = toTicketView(
      {
        ...accepted,
        photos: [
          {
            id: 'upl_9',
            purpose: 'REPAIR_PROOF',
            addedAt: 'x',
            repairCycle: 2,
            s3ObjectKey: 'uploads/REPAIR_PROOF/acct/upl_9',
          },
        ],
      },
      'REPORTER',
    );
    expect(view.photos).toEqual([
      { id: 'upl_9', purpose: 'REPAIR_PROOF', addedAt: 'x', repairCycle: 2 },
    ]);
  });
});
