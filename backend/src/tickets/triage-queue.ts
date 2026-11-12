import { recentMonths } from './dashboard.js';

/**
 * The tickets waiting for a manager's triage (SCFRMS-42, RR-12, SLA-06) are the
 * ones still RECEIVED: the automatic triage could not classify them, so they
 * have no team and no deadline and are in no team's queue. They are read from
 * CreatedMonthIndex, which has no status in its key, so the read is limited to
 * the last TRIAGE_QUEUE_MONTHS months (a whole number from 1 to 24, default 3).
 * A ticket that has waited longer than that for triage is not listed, and not
 * alerted either; the first alert comes after minutes (see sla/alerts.ts), so
 * that only matters when the alert emails are not read for months.
 */

const DEFAULT_MONTHS = 3;
const MAX_MONTHS = 24;

export function triageQueueMonths(
  setting: string | undefined = process.env.TRIAGE_QUEUE_MONTHS,
): number {
  const value = Number(setting);
  return Number.isInteger(value) && value >= 1 && value <= MAX_MONTHS
    ? value
    : DEFAULT_MONTHS;
}

/** The months to read, oldest first, so the oldest waiting ticket comes first. */
export function triageQueueWindow(now: Date): string[] {
  return recentMonths(now, triageQueueMonths()).reverse();
}
