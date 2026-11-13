import { downloadCsv } from './csv';
import { shortId, slaLeft, teamLabel } from './format';
import type { Ticket } from '../services/types';

/** Matches the full id, the short #id, description, location or team name. */
export function matchesSearch(t: Ticket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t.id, shortId(t.id), t.description, t.location, teamLabel(t.teamId)].some((v) =>
    v.toLowerCase().includes(q),
  );
}

export function exportTickets(tickets: Ticket[], now: number, filename: string): void {
  downloadCsv(filename, [
    ['Ticket', 'Description', 'Location', 'Team', 'Priority', 'Status', 'SLA left', 'Created'],
    ...tickets.map((t) => [
      t.id,
      t.description,
      t.location,
      teamLabel(t.teamId),
      t.priority,
      t.status,
      slaLeft(t, now).text,
      t.createdAt,
    ]),
  ]);
}