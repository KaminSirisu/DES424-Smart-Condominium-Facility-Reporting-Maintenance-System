import type { Priority, TeamId, TicketStatus } from '../services/types';

export const TEAMS: { id: TeamId; label: string }[] = [
  { id: 'ELECTRICAL', label: 'Electrical' },
  { id: 'PLUMBING', label: 'Plumbing' },
  { id: 'HVAC', label: 'HVAC' },
  { id: 'CLEANING_SANITATION', label: 'Cleaning / Sanitation' },
  { id: 'BUILDING_EQUIPMENT', label: 'Building equipment' },
];

export const PRIORITIES: Priority[] = ['CRITICAL', 'MEDIUM', 'LOW'];

/* Display copy of backend/src/triage/policy.ts. Change both together */
export const SLA_POLICY: Record<
  Priority,
  { respondMinutes: number; fixHours: number }
> = {
  CRITICAL: { respondMinutes: 15, fixHours: 3 },
  MEDIUM: { respondMinutes: 120, fixHours: 12 },
  LOW: { respondMinutes: 1440, fixHours: 48 },
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  RECEIVED: 'Received',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  MERGED: 'Merged',
};

export const OPEN_STATUSES: TicketStatus[] = [
  'RECEIVED',
  'ASSIGNED',
  'IN_PROGRESS',
];
/**
 * Who set the priority. The ticket's prioritySetBy is only AI or STAFF, and
 * STAFF can be a technician or a manager, so the label comes from the event:
 * a technician's event has actorTeamId, a manager's does not.
 */
export const ACTOR_LABEL = {
  AI: 'AI',
  TECHNICIAN: 'Technician',
  MANAGER: 'Manager',
} as const;
