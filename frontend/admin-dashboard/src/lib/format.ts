import { ACTOR_LABEL, OPEN_STATUSES, TEAMS } from './constants';
import type { Ticket, TicketEvent } from '../services/types';

export function shortId(id: string): string {
  return '#' + id.replace(/^tkt_/, '').slice(0, 8).toUpperCase();
}

export function teamLabel(teamId?: string): string {
  if (!teamId) return '—';
  return TEAMS.find((t) => t.id === teamId)?.label ?? teamId;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(Math.abs(ms) / 60000);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

export function isOpen(t: Ticket): boolean {
  return OPEN_STATUSES.includes(t.status);
}

/** Same rule as the backend: ASSIGNED/IN_PROGRESS and the deadline has passed. */
export function isOverdue(t: Ticket, now: number): boolean {
  return (
    (t.status === 'ASSIGNED' || t.status === 'IN_PROGRESS') &&
    !!t.deadlineAt &&
    Date.parse(t.deadlineAt) < now
  );
}

export function slaLeft(
  t: Ticket,
  now: number,
): { text: string; overdue: boolean } {
  if (t.status === 'DONE' || t.status === 'MERGED')
    return { text: 'closed', overdue: false };
  if (!t.deadlineAt) return { text: '—', overdue: false };
  const diff = Date.parse(t.deadlineAt) - now;
  return diff < 0
    ? { text: `over ${formatDuration(diff)}`, overdue: true }
    : { text: formatDuration(diff), overdue: false };
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
}

/** Who did this event: AI/system, a technician (has a team) or a manager. */
export function actorLabel(e: TicketEvent): string {
  if (e.actorType !== 'STAFF') return ACTOR_LABEL.AI;
  return e.actorTeamId ? ACTOR_LABEL.TECHNICIAN : ACTOR_LABEL.MANAGER;
}

/**
 * Who set the ticket's current priority. AI when prioritySetBy is AI;
 * otherwise the actor of the latest event that set a priority.
 */
export function prioritySetByLabel(
  t: Ticket,
  events: TicketEvent[] = [],
): string {
  if (t.prioritySetBy !== 'STAFF') return ACTOR_LABEL.AI;
  const last = [...events].reverse().find((e) => e.toPriority !== undefined);
  return last ? actorLabel(last) : 'Staff'; // events not loaded yet
}
