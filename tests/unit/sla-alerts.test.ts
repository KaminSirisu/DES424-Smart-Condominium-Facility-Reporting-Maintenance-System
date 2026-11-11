import { describe, expect, it } from 'vitest';
import { dueAlerts } from '../../backend/src/sla/alerts';
import type { TicketRecord } from '../../backend/src/tickets/types';

const MIN = 60_000;
const START = Date.parse('2026-11-11T08:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * MIN);
const iso = (minutes: number) => at(minutes).toISOString();

/** A MEDIUM ticket: 12 hours to resolve (deadline at 720 min), 120 min to respond. */
function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 3,
    reporterLineUserId: 'Uabc',
    teamId: 'PLUMBING',
    category: 'PLUMBING',
    priority: 'MEDIUM',
    deadlineAt: iso(720),
    createdAt: iso(0),
    updatedAt: iso(1),
    ...overrides,
  };
}
const kinds = (t: TicketRecord, minutes: number) =>
  dueAlerts(t, at(minutes)).map((a) => a.kind);

describe('dueAlerts for a ticket waiting for triage (SLA-06)', () => {
  const waiting = (overrides: Partial<TicketRecord> = {}) =>
    ticket({
      status: 'RECEIVED',
      teamId: undefined,
      category: undefined,
      priority: undefined,
      deadlineAt: undefined,
      ...overrides,
    });

  it('owes nothing in the first five minutes', () => {
    expect(dueAlerts(waiting(), at(0))).toEqual([]);
    expect(dueAlerts(waiting(), new Date(START + 5 * MIN - 1))).toEqual([]);
  });

  it('owes the triage delay alert from five minutes after creation', () => {
    expect(dueAlerts(waiting(), at(5))).toEqual([{ kind: 'TRIAGE_DELAYED' }]);
    expect(dueAlerts(waiting(), at(600))).toEqual([{ kind: 'TRIAGE_DELAYED' }]);
  });

  it('owes it once', () => {
    expect(dueAlerts(waiting({ slaTriageDelayedAt: iso(6) }), at(600))).toEqual(
      [],
    );
  });

  it('owes nothing else: no warning, response or breach without a team and a deadline', () => {
    expect(dueAlerts(waiting(), at(100_000))).toEqual([
      { kind: 'TRIAGE_DELAYED' },
    ]);
  });

  it('counts from creation and owes nothing for a creation time that cannot be read', () => {
    expect(dueAlerts(waiting({ createdAt: 'then' }), at(600))).toEqual([]);
  });
});

describe('dueAlerts', () => {
  it('owes nothing early in the clock', () => {
    expect(dueAlerts(ticket(), at(0))).toEqual([]);
    expect(dueAlerts(ticket(), at(119))).toEqual([]);
  });

  describe('the response target (E1)', () => {
    it('is missed at the target for a ticket that is still ASSIGNED', () => {
      expect(kinds(ticket(), 120)).toEqual(['RESPONSE_BREACH']);
      expect(kinds(ticket(), 121)).toEqual(['RESPONSE_BREACH']);
    });
    it('depends on the priority: 15 minutes, 2 hours, 24 hours', () => {
      const critical = ticket({ priority: 'CRITICAL', deadlineAt: iso(180) });
      expect(kinds(critical, 14)).toEqual([]);
      expect(kinds(critical, 15)).toEqual(['RESPONSE_BREACH']);
      const low = ticket({ priority: 'LOW', deadlineAt: iso(2880) });
      expect(kinds(low, 1439)).toEqual([]);
      expect(kinds(low, 1440)).toEqual(['RESPONSE_BREACH']);
    });
    it('is not owed once work started, or twice', () => {
      expect(kinds(ticket({ status: 'IN_PROGRESS' }), 300)).toEqual([]);
      expect(kinds(ticket({ slaResponseBreachedAt: iso(121) }), 300)).toEqual(
        [],
      );
    });
    it('counts from the start of the current SLA clock, not from creation', () => {
      const reopened = ticket({ slaStartAt: iso(1000), deadlineAt: iso(1720) });
      expect(kinds(reopened, 1119)).toEqual([]);
      expect(kinds(reopened, 1120)).toEqual(['RESPONSE_BREACH']);
    });
    it('needs a priority to know the target', () => {
      expect(kinds(ticket({ priority: undefined }), 300)).toEqual([]);
    });
  });

  describe('the warning at 75% of the resolution time (E0)', () => {
    it('comes at 75% of the time from the start to the deadline', () => {
      // 75% of 720 minutes is 540.
      const started = ticket({ status: 'IN_PROGRESS' });
      expect(kinds(started, 539)).toEqual([]);
      expect(kinds(started, 540)).toEqual(['WARNING']);
      expect(kinds(started, 719)).toEqual(['WARNING']);
    });
    it('uses the start of the current SLA clock', () => {
      const merged = ticket({
        status: 'IN_PROGRESS',
        slaStartAt: iso(-240),
        deadlineAt: iso(720),
      });
      // 960 minutes in total, so 75% is 720 minutes after the start: minute 480.
      expect(kinds(merged, 479)).toEqual([]);
      expect(kinds(merged, 480)).toEqual(['WARNING']);
    });
    it('is not owed twice, nor once the deadline has passed (the breach comes instead)', () => {
      expect(
        kinds(ticket({ status: 'IN_PROGRESS', slaWarnedAt: iso(541) }), 600),
      ).toEqual([]);
      expect(kinds(ticket({ status: 'IN_PROGRESS' }), 720)).toEqual([
        'RESOLUTION_BREACH',
      ]);
    });
  });

  describe('the resolution deadline (E2)', () => {
    it('is breached at the deadline, for a ticket in either open status', () => {
      expect(kinds(ticket({ status: 'IN_PROGRESS' }), 719)).toEqual([
        'WARNING',
      ]);
      expect(dueAlerts(ticket({ status: 'IN_PROGRESS' }), at(720))).toEqual([
        { kind: 'RESOLUTION_BREACH', sent: 0 },
      ]);
      expect(
        dueAlerts(
          ticket({ slaResponseBreachedAt: iso(121), slaWarnedAt: iso(541) }),
          at(721),
        ),
      ).toEqual([{ kind: 'RESOLUTION_BREACH', sent: 0 }]);
    });

    it('is owed in time order when an old ticket is first seen: response, then breach', () => {
      expect(kinds(ticket(), 900)).toEqual([
        'RESPONSE_BREACH',
        'RESOLUTION_BREACH',
      ]);
    });

    it('is alerted once for any priority but CRITICAL', () => {
      const breached = ticket({
        status: 'IN_PROGRESS',
        slaBreachedAt: iso(720),
        slaBreachAlerts: 1,
        slaLastBreachAlertAt: iso(720),
      });
      expect(dueAlerts(breached, at(10_000))).toEqual([]);
    });

    describe('a CRITICAL ticket', () => {
      const critical = (extra: Partial<TicketRecord> = {}) =>
        ticket({
          priority: 'CRITICAL',
          status: 'IN_PROGRESS',
          deadlineAt: iso(180),
          slaBreachedAt: iso(185),
          slaBreachAlerts: 1,
          slaLastBreachAlertAt: iso(185),
          ...extra,
        });

      it('is reminded every 60 minutes after the last alert until it is done', () => {
        expect(dueAlerts(critical(), at(244))).toEqual([]);
        expect(dueAlerts(critical(), at(245))).toEqual([
          { kind: 'RESOLUTION_BREACH', sent: 1 },
        ]);
        const second = critical({
          slaBreachAlerts: 2,
          slaLastBreachAlertAt: iso(245),
        });
        expect(dueAlerts(second, at(304))).toEqual([]);
        expect(dueAlerts(second, at(305))).toEqual([
          { kind: 'RESOLUTION_BREACH', sent: 2 },
        ]);
      });

      it('counts one alert when the field is missing', () => {
        expect(
          dueAlerts(critical({ slaBreachAlerts: undefined }), at(245)),
        ).toEqual([{ kind: 'RESOLUTION_BREACH', sent: 1 }]);
      });

      it('is not reminded without a time for the last alert, or after a downgrade', () => {
        expect(
          dueAlerts(critical({ slaLastBreachAlertAt: undefined }), at(500)),
        ).toEqual([]);
        expect(dueAlerts(critical({ priority: 'MEDIUM' }), at(500))).toEqual(
          [],
        );
      });
    });
  });

  describe('a ticket that owes nothing', () => {
    it.each(['DONE', 'MERGED'] as const)(
      'is %s: the clock is not running',
      (status) => {
        expect(dueAlerts(ticket({ status }), at(10_000))).toEqual([]);
      },
    );
    it('has no deadline', () => {
      expect(dueAlerts(ticket({ deadlineAt: undefined }), at(10_000))).toEqual(
        [],
      );
      expect(dueAlerts(ticket({ deadlineAt: 'soon' }), at(10_000))).toEqual([]);
    });
    it('has a start that cannot be read', () => {
      expect(dueAlerts(ticket({ createdAt: 'then' }), at(10_000))).toEqual([]);
    });
  });
});
