import { TEAM_IDS } from '../triage/policy.js';
import { toTicketView } from './ticket-view.js';
import type { TicketRecord, TicketStatus } from './types.js';

/**
 * What the manager dashboard counts (SCFRMS-43): the pure part of
 * GET /dashboard/summary and GET /dashboard/history. The handlers read the
 * tickets (shared/ticket-repository.ts, listTicketsOfMonths) and these
 * functions turn them into the openapi.yaml shapes, so every figure is counted
 * from the records and never from a page of them.
 */

export const STATUSES: TicketStatus[] = [
  'RECEIVED',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'MERGED',
];
/** The statuses of work that is not finished: openapi.yaml, DashboardSummary.openCount. */
const OPEN_STATUSES: TicketStatus[] = ['RECEIVED', 'ASSIGNED', 'IN_PROGRESS'];
/** Open work that has a team and a deadline. */
const ASSIGNED_STATUSES: TicketStatus[] = ['ASSIGNED', 'IN_PROGRESS'];

/** Orders text by code point, so the order does not depend on the runtime's locale. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Locations are free text, so the breakdown is cut to the most reported ones. */
export const LOCATION_BREAKDOWN_MAX = 100;

const DEFAULT_MAX_MONTHS = 24;
const MAX_MONTHS_LIMIT = 120;

/**
 * How many months back a dashboard request reads, from DASHBOARD_MAX_MONTHS
 * (a whole number from 1 to 120, default 24). The report is bounded because
 * every figure is counted from the tickets themselves.
 */
export function maxMonths(
  setting: string | undefined = process.env.DASHBOARD_MAX_MONTHS,
): number {
  const value = Number(setting);
  return Number.isInteger(value) && value >= 1 && value <= MAX_MONTHS_LIMIT
    ? value
    : DEFAULT_MAX_MONTHS;
}

/** The last `count` months up to the one of `now` (UTC), newest first, as `YYYY-MM`. */
export function recentMonths(now: Date, count: number): string[] {
  const months: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  for (let i = 0; i < count; i++) {
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return months;
}

/** Times the repair of a ticket was finished: earlier cycles, and this one if it is DONE. */
export function completionCountOf(ticket: TicketRecord): number {
  return ticket.repairCycle - 1 + (ticket.status === 'DONE' ? 1 : 0);
}

/** Times a ticket was reopened: every cycle after the first. */
export function reopenCountOf(ticket: TicketRecord): number {
  return ticket.repairCycle - 1;
}

function statusCounts(tickets: TicketRecord[]): Record<TicketStatus, number> {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    TicketStatus,
    number
  >;
  for (const ticket of tickets) counts[ticket.status] += 1;
  return counts;
}

export interface DashboardSummary {
  openCount: number;
  overdueCount: number;
  countsByStatus: Record<TicketStatus, number>;
  teamWorkloads: { teamId: string; openCount: number }[];
  generatedAt: string;
}

/**
 * The current counts: open work, work past its deadline, every status, and
 * what each team has open. All five teams are listed, an idle one with 0, so a
 * workload view has no gaps. A ticket is overdue when it is ASSIGNED or
 * IN_PROGRESS and its stored deadline has passed.
 */
export function summarize(
  tickets: TicketRecord[],
  now: Date,
): DashboardSummary {
  const workload = new Map<string, number>(TEAM_IDS.map((id) => [id, 0]));
  let overdue = 0;
  for (const ticket of tickets) {
    if (!ASSIGNED_STATUSES.includes(ticket.status)) continue;
    if (ticket.teamId && workload.has(ticket.teamId)) {
      workload.set(ticket.teamId, (workload.get(ticket.teamId) ?? 0) + 1);
    }
    if (ticket.deadlineAt && Date.parse(ticket.deadlineAt) < now.getTime()) {
      overdue += 1;
    }
  }
  return {
    openCount: tickets.filter((t) => OPEN_STATUSES.includes(t.status)).length,
    overdueCount: overdue,
    countsByStatus: statusCounts(tickets),
    teamWorkloads: [...workload]
      .map(([teamId, openCount]) => ({ teamId, openCount }))
      .sort((a, b) => byText(a.teamId, b.teamId)),
    generatedAt: now.toISOString(),
  };
}

export interface HistorySummary {
  totalTickets: number;
  countsByStatus: Record<TicketStatus, number>;
  countsByPriority: Record<string, number>;
  countsByTeam: Record<string, number>;
  locationBreakdown: {
    location: string;
    reportedCount: number;
    completedCount: number;
  }[];
  completionCount: number;
  reopenCount: number;
}

function tally(values: (string | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * The totals over every matching ticket. Priority and team count only the
 * tickets that have one. A location is the exact text the reporter wrote, so
 * spelling variants stay apart, and `completedCount` is the tickets of that
 * location that were finished at least once. The breakdown lists the
 * LOCATION_BREAKDOWN_MAX most reported locations, most reported first.
 */
export function historySummary(tickets: TicketRecord[]): HistorySummary {
  const locations = new Map<
    string,
    { reportedCount: number; completedCount: number }
  >();
  let completions = 0;
  let reopens = 0;
  for (const ticket of tickets) {
    const completed = completionCountOf(ticket);
    completions += completed;
    reopens += reopenCountOf(ticket);

    const entry = locations.get(ticket.location) ?? {
      reportedCount: 0,
      completedCount: 0,
    };
    entry.reportedCount += 1;
    if (completed > 0) entry.completedCount += 1;
    locations.set(ticket.location, entry);
  }

  return {
    totalTickets: tickets.length,
    countsByStatus: statusCounts(tickets),
    countsByPriority: tally(tickets.map((t) => t.priority)),
    countsByTeam: tally(tickets.map((t) => t.teamId)),
    locationBreakdown: [...locations]
      .map(([location, counts]) => ({ location, ...counts }))
      .sort(
        (a, b) =>
          b.reportedCount - a.reportedCount || byText(a.location, b.location),
      )
      .slice(0, LOCATION_BREAKDOWN_MAX),
    completionCount: completions,
    reopenCount: reopens,
  };
}

/** One row of the history: the ticket as callers see it, plus its repair counts. */
export function historyEntry(ticket: TicketRecord): Record<string, unknown> {
  const lastCompletedAt = ticket.lastCompletedAt ?? ticket.completedAt;
  return {
    ticket: toTicketView(ticket),
    completionCount: completionCountOf(ticket),
    reopenCount: reopenCountOf(ticket),
    ...(lastCompletedAt ? { lastCompletedAt } : {}),
  };
}

/** The position of a ticket in the history, newest first: how the cursor finds its place. */
export function historyKey(ticket: TicketRecord): string {
  return `${ticket.createdAt}#${ticket.id}`;
}
