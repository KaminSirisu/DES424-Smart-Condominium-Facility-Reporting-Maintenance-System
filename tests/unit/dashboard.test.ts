import { describe, expect, it } from 'vitest';
import {
  LOCATION_BREAKDOWN_MAX,
  completionCountOf,
  historyEntry,
  historyKey,
  historySummary,
  maxMonths,
  recentMonths,
  summarize,
} from '../../backend/src/tickets/dashboard';
import type {
  TicketRecord,
  TicketStatus,
} from '../../backend/src/tickets/types';

const NOW = new Date('2026-11-11T08:00:00.000Z');

function ticket(
  id: string,
  overrides: Partial<TicketRecord> = {},
): TicketRecord {
  return {
    id,
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 3,
    reporterLineUserId: 'Ureporter',
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    deadlineAt: '2026-11-12T08:00:00.000Z',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
    ...overrides,
  };
}

describe('maxMonths', () => {
  it('is 24 months unless DASHBOARD_MAX_MONTHS says another whole number from 1 to 120', () => {
    expect(maxMonths(undefined)).toBe(24);
    expect(maxMonths('6')).toBe(6);
    expect(maxMonths('1')).toBe(1);
    expect(maxMonths('120')).toBe(120);
  });

  it.each(['', 'abc', '0', '-3', '2.5', '121', '1e3'])(
    'falls back to 24 for %j',
    (value) => {
      expect(maxMonths(value)).toBe(24);
    },
  );
});

describe('recentMonths', () => {
  it('lists the last months up to the current one, newest first', () => {
    expect(recentMonths(NOW, 3)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(recentMonths(NOW, 1)).toEqual(['2026-11']);
    expect(recentMonths(NOW, 0)).toEqual([]);
  });

  it('goes back over a year end', () => {
    expect(recentMonths(new Date('2026-01-31T23:59:59.000Z'), 3)).toEqual([
      '2026-01',
      '2025-12',
      '2025-11',
    ]);
  });

  it('counts months in UTC, as ticket creation times are stored', () => {
    // 2026-11-30 23:30 in UTC is already December in Bangkok (UTC+7)
    expect(recentMonths(new Date('2026-11-30T23:30:00.000Z'), 1)).toEqual([
      '2026-11',
    ]);
  });
});

describe('completion and reopen counts', () => {
  it.each([
    ['a first cycle that is open', 1, 'ASSIGNED', 0, 0],
    ['a first cycle that is DONE', 1, 'DONE', 1, 0],
    ['a reopened ticket that is open again', 2, 'ASSIGNED', 1, 1],
    ['a reopened ticket that is DONE again', 2, 'DONE', 2, 1],
    ['a reopened ticket that was merged', 3, 'MERGED', 2, 2],
  ] as const)('for %s', (_label, repairCycle, status, completions, reopens) => {
    const t = ticket('t', { repairCycle, status: status as TicketStatus });
    const entry = historyEntry(t);
    expect(completionCountOf(t)).toBe(completions);
    expect(entry.completionCount).toBe(completions);
    expect(entry.reopenCount).toBe(reopens);
  });
});

describe('summarize', () => {
  const tickets = [
    ticket('received', {
      status: 'RECEIVED',
      teamId: undefined,
      deadlineAt: undefined,
      priority: undefined,
    }),
    ticket('assigned', { status: 'ASSIGNED', teamId: 'PLUMBING' }),
    ticket('late-assigned', {
      status: 'ASSIGNED',
      teamId: 'HVAC',
      deadlineAt: '2026-11-11T07:59:59.000Z',
    }),
    ticket('late-progress', {
      status: 'IN_PROGRESS',
      teamId: 'HVAC',
      deadlineAt: '2026-11-10T00:00:00.000Z',
    }),
    ticket('late-done', {
      status: 'DONE',
      deadlineAt: '2026-11-01T00:00:00.000Z',
    }),
    ticket('merged', { status: 'MERGED' }),
  ];

  it('counts the open work, the overdue work and every status', () => {
    const summary = summarize(tickets, NOW);

    expect(summary.openCount).toBe(4); // RECEIVED, ASSIGNED, 2 ticket(s) late: 1 + 1 + 1 + 1
    expect(summary.overdueCount).toBe(2);
    expect(summary.countsByStatus).toEqual({
      RECEIVED: 1,
      ASSIGNED: 2,
      IN_PROGRESS: 1,
      DONE: 1,
      MERGED: 1,
    });
    expect(summary.generatedAt).toBe('2026-11-11T08:00:00.000Z');
  });

  it('is overdue only after the deadline, and only for ASSIGNED or IN_PROGRESS work', () => {
    const exactly = ticket('x', { deadlineAt: NOW.toISOString() });
    expect(summarize([exactly], NOW).overdueCount).toBe(0);

    const justPast = ticket('y', { deadlineAt: '2026-11-11T07:59:59.999Z' });
    expect(summarize([justPast], NOW).overdueCount).toBe(1);

    // a finished or merged ticket past its deadline, and a ticket that has none
    expect(
      summarize(
        [
          ticket('d', {
            status: 'DONE',
            deadlineAt: '2026-01-01T00:00:00.000Z',
          }),
          ticket('m', {
            status: 'MERGED',
            deadlineAt: '2026-01-01T00:00:00.000Z',
          }),
          ticket('r', { status: 'RECEIVED', deadlineAt: undefined }),
        ],
        NOW,
      ).overdueCount,
    ).toBe(0);
  });

  it('lists all five teams with what each has open, an idle team with 0', () => {
    expect(summarize(tickets, NOW).teamWorkloads).toEqual([
      { teamId: 'BUILDING_EQUIPMENT', openCount: 0 },
      { teamId: 'CLEANING_SANITATION', openCount: 0 },
      { teamId: 'ELECTRICAL', openCount: 0 },
      { teamId: 'HVAC', openCount: 2 },
      { teamId: 'PLUMBING', openCount: 1 },
    ]);
  });

  it('counts nothing for no tickets, and keeps every status and team in the answer', () => {
    const summary = summarize([], NOW);
    expect(summary.openCount).toBe(0);
    expect(summary.overdueCount).toBe(0);
    expect(Object.keys(summary.countsByStatus)).toHaveLength(5);
    expect(summary.teamWorkloads).toHaveLength(5);
  });

  it('leaves a ticket of an unknown team out of the workloads', () => {
    const odd = ticket('odd', { teamId: 'NOPE' });
    expect(
      summarize([odd], NOW).teamWorkloads.every((w) => w.openCount === 0),
    ).toBe(true);
  });
});

describe('historySummary', () => {
  it('counts every ticket by status, priority and team, and the cycles', () => {
    const summary = historySummary([
      ticket('a', { status: 'DONE', repairCycle: 2, priority: 'CRITICAL' }),
      ticket('b', { status: 'ASSIGNED', teamId: 'HVAC', priority: 'LOW' }),
      ticket('c', {
        status: 'RECEIVED',
        teamId: undefined,
        priority: undefined,
      }),
    ]);

    expect(summary.totalTickets).toBe(3);
    expect(summary.countsByStatus).toEqual({
      RECEIVED: 1,
      ASSIGNED: 1,
      IN_PROGRESS: 0,
      DONE: 1,
      MERGED: 0,
    });
    // a ticket without a priority or a team is left out of those two
    expect(summary.countsByPriority).toEqual({ CRITICAL: 1, LOW: 1 });
    expect(summary.countsByTeam).toEqual({ PLUMBING: 1, HVAC: 1 });
    expect(summary.completionCount).toBe(2); // a: cycle 1 and cycle 2
    expect(summary.reopenCount).toBe(1);
  });

  it('groups the exact location text, most reported first, and counts the finished ones', () => {
    const summary = historySummary([
      ticket('1', { location: 'Gym' }),
      ticket('2', { location: 'Lobby', status: 'DONE' }),
      ticket('3', { location: 'Lobby' }),
      ticket('4', { location: 'lobby' }),
      ticket('5', { location: 'Lobby ' }),
      // reopened and open again: finished once before
      ticket('6', { location: 'Gym', repairCycle: 2 }),
    ]);

    expect(summary.locationBreakdown).toEqual([
      { location: 'Gym', reportedCount: 2, completedCount: 1 },
      { location: 'Lobby', reportedCount: 2, completedCount: 1 },
      { location: 'Lobby ', reportedCount: 1, completedCount: 0 },
      { location: 'lobby', reportedCount: 1, completedCount: 0 },
    ]);
  });

  it('lists only the most reported locations', () => {
    const many = Array.from({ length: LOCATION_BREAKDOWN_MAX + 20 }, (_, i) =>
      ticket(`t${i}`, { location: `Place ${String(i).padStart(3, '0')}` }),
    );
    // one place reported twice must be on the list
    many.push(ticket('extra', { location: 'Place 119' }));

    const { locationBreakdown } = historySummary(many);

    expect(locationBreakdown).toHaveLength(LOCATION_BREAKDOWN_MAX);
    expect(locationBreakdown[0]).toEqual({
      location: 'Place 119',
      reportedCount: 2,
      completedCount: 0,
    });
  });

  it('is zero for no tickets', () => {
    expect(historySummary([])).toEqual({
      totalTickets: 0,
      countsByStatus: {
        RECEIVED: 0,
        ASSIGNED: 0,
        IN_PROGRESS: 0,
        DONE: 0,
        MERGED: 0,
      },
      countsByPriority: {},
      countsByTeam: {},
      locationBreakdown: [],
      completionCount: 0,
      reopenCount: 0,
    });
  });
});

describe('historyEntry', () => {
  it('holds the ticket as callers see it, without private fields', () => {
    const entry = historyEntry(
      ticket('t', {
        photos: [
          {
            id: 'upl_1',
            purpose: 'DEFECT',
            addedAt: '2026-11-05T08:00:00.000Z',
            s3ObjectKey: 'uploads/DEFECT/Ureporter/upl_1',
          },
        ],
      }),
    );

    expect(entry.ticket).toMatchObject({ id: 't', status: 'ASSIGNED' });
    const json = JSON.stringify(entry);
    for (const hidden of ['Ureporter', 's3ObjectKey', 'uploads/', 'version']) {
      expect(json).not.toContain(hidden);
    }
  });

  it('reports when the repair was last finished, also after a reopen', () => {
    expect(
      historyEntry(
        ticket('a', {
          status: 'DONE',
          completedAt: '2026-11-06T10:00:00.000Z',
        }),
      ).lastCompletedAt,
    ).toBe('2026-11-06T10:00:00.000Z');

    // reopened: completedAt was removed, lastCompletedAt was kept
    expect(
      historyEntry(
        ticket('b', {
          repairCycle: 2,
          lastCompletedAt: '2026-11-06T10:00:00.000Z',
        }),
      ).lastCompletedAt,
    ).toBe('2026-11-06T10:00:00.000Z');

    // never finished
    expect(historyEntry(ticket('c'))).not.toHaveProperty('lastCompletedAt');
  });

  it('prefers the kept time over completedAt', () => {
    expect(
      historyEntry(
        ticket('d', {
          status: 'DONE',
          repairCycle: 2,
          completedAt: '2026-11-08T10:00:00.000Z',
          lastCompletedAt: '2026-11-08T10:00:00.000Z',
        }),
      ).lastCompletedAt,
    ).toBe('2026-11-08T10:00:00.000Z');
  });
});

describe('historyKey', () => {
  it('orders by creation time, then id', () => {
    const a = historyKey(
      ticket('a', { createdAt: '2026-11-05T08:00:00.000Z' }),
    );
    const b = historyKey(
      ticket('b', { createdAt: '2026-11-05T09:00:00.000Z' }),
    );
    expect(a).toBe('2026-11-05T08:00:00.000Z#a');
    expect(a < b).toBe(true);
  });
});
