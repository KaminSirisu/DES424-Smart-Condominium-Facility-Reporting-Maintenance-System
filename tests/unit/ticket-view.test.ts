import { describe, expect, it } from 'vitest';
import { toTicketView } from '../../backend/src/tickets/create-ticket';
import type { TicketRecord } from '../../backend/src/tickets/types';

const triaged: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'ASSIGNED',
  repairCycle: 1,
  photos: [
    {
      id: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-10-28T10:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
    },
  ],
  version: 2,
  reporterLineUserId: 'Uabc123',
  category: 'PLUMBING',
  suggestedPriority: 'MEDIUM',
  priority: 'CRITICAL',
  prioritySetBy: 'AI',
  safetyHazard: 'GAS',
  teamId: 'PLUMBING',
  deadlineAt: '2026-10-28T14:00:00.000Z',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:30:00.000Z',
};

describe('toTicketView', () => {
  it('returns the caller-visible fields of a triaged ticket', () => {
    expect(toTicketView(triaged)).toEqual({
      id: 'tkt_1',
      location: 'Lobby',
      description: 'Water is leaking.',
      status: 'ASSIGNED',
      repairCycle: 1,
      category: 'PLUMBING',
      suggestedPriority: 'MEDIUM',
      priority: 'CRITICAL',
      prioritySetBy: 'AI',
      teamId: 'PLUMBING',
      deadlineAt: '2026-10-28T14:00:00.000Z',
      createdAt: '2026-10-28T10:00:00.000Z',
      updatedAt: '2026-10-28T10:30:00.000Z',
      photos: [
        { id: 'upl_1', purpose: 'DEFECT', addedAt: '2026-10-28T10:00:00.000Z' },
      ],
    });
  });

  it.each(['reporterLineUserId', 'version', 'safetyHazard'])(
    'does not expose the internal field %s',
    (field) => {
      expect(toTicketView(triaged)).not.toHaveProperty(field);
    },
  );

  it('never exposes a photo S3 key', () => {
    expect(JSON.stringify(toTicketView(triaged))).not.toContain('uploads/');
    expect(JSON.stringify(toTicketView(triaged))).not.toContain('s3ObjectKey');
  });
});
