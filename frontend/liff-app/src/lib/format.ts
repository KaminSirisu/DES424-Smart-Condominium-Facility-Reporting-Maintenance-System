import type { Ticket, TicketStatus } from '../services/api';

// Same short reference as the LINE messages (backend ticket-reference.ts).
export function shortId(id: string): string {
  return '#' + id.replace(/^tkt_/, '').slice(0, 8).toUpperCase();
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  RECEIVED: 'Received',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  MERGED: 'Merged',
};

// Copy of the team list in the staff UI (admin-dashboard lib/constants.ts).
const TEAM_LABEL: Record<string, string> = {
  ELECTRICAL: 'Electrical',
  PLUMBING: 'Plumbing',
  HVAC: 'HVAC',
  CLEANING_SANITATION: 'Cleaning / Sanitation',
  BUILDING_EQUIPMENT: 'Building equipment',
};

export function teamLabel(teamId?: string): string | undefined {
  if (!teamId) return undefined;
  return TEAM_LABEL[teamId] ?? teamId;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Same rule as backend reopen-ticket.ts: DONE and finished at most 7 days ago.
export const REOPEN_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function reopenDeadline(t: Ticket): Date | null {
  if (t.status !== 'DONE') return null;
  const done = Date.parse(t.completedAt ?? t.updatedAt);
  if (Number.isNaN(done)) return null;
  return new Date(done + REOPEN_WINDOW_DAYS * DAY_MS);
}

export function canReopen(t: Ticket, now: number = Date.now()): boolean {
  const deadline = reopenDeadline(t);
  return deadline !== null && now <= deadline.getTime();
}

// Latest repair-proof photo of the current repair cycle, else the latest one.
export function latestProofPhoto(t: Ticket) {
  const proofs = t.photos.filter((p) => p.purpose === 'REPAIR_PROOF');
  return (
    [...proofs].reverse().find((p) => p.repairCycle === t.repairCycle) ??
    proofs[proofs.length - 1]
  );
}

export function defectPhoto(t: Ticket) {
  return t.photos.find((p) => p.purpose === 'DEFECT');
}
