import { Priority } from '../tickets/types';

/**
 * Triage policy for SCFRMS-41: which teams exist, how impact × urgency maps
 * to a priority, and how long each priority gets to reach DONE.
 *
 * Source: "SCFRMS Security, Roles & SLA Requirements" §3 (proposed defaults,
 * still to be confirmed by the team). That document calls the top priority
 * HIGH; openapi.yaml calls it CRITICAL, and the API contract wins, so HIGH
 * is stored as CRITICAL.
 */

export const TEAM_IDS = [
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'CLEANING_SANITATION',
  'BUILDING_EQUIPMENT',
] as const;
export type TeamId = (typeof TEAM_IDS)[number];

/** A maintenance domain maps one-to-one to a team. */
export const CATEGORIES = TEAM_IDS;
export type Category = TeamId;

export const TEAM_FOR_CATEGORY: Record<Category, TeamId> = {
  ELECTRICAL: 'ELECTRICAL',
  PLUMBING: 'PLUMBING',
  HVAC: 'HVAC',
  CLEANING_SANITATION: 'CLEANING_SANITATION',
  BUILDING_EQUIPMENT: 'BUILDING_EQUIPMENT',
};

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';

const PRIORITIES: readonly Priority[] = ['CRITICAL', 'MEDIUM', 'LOW'];

export function isTeamId(value: unknown): value is TeamId {
  return TEAM_IDS.includes(value as TeamId);
}

export function isCategory(value: unknown): value is Category {
  return isTeamId(value);
}

export function isPriority(value: unknown): value is Priority {
  return PRIORITIES.includes(value as Priority);
}

export function isLevel(value: unknown): value is Level {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW';
}

/** Priority = Impact × Urgency (ITIL matrix, requirements doc §3.4). */
const MATRIX: Record<Level, Record<Level, Priority>> = {
  HIGH: { HIGH: 'CRITICAL', MEDIUM: 'CRITICAL', LOW: 'MEDIUM' },
  MEDIUM: { HIGH: 'CRITICAL', MEDIUM: 'MEDIUM', LOW: 'LOW' },
  LOW: { HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'LOW' },
};

export function priorityFor(impact: Level, urgency: Level): Priority {
  return MATRIX[impact][urgency];
}

/** Default hours from created_at to DONE (requirements doc §3.5). */
const DEFAULT_RESOLUTION_HOURS: Record<Priority, number> = {
  CRITICAL: 4,
  MEDIUM: 24,
  LOW: 120,
};

/** Per-team overrides; empty until the juristic office confirms any. */
const TEAM_RESOLUTION_HOURS: Partial<
  Record<TeamId, Partial<Record<Priority, number>>>
> = {};

export const SLA_POLICY_VERSION = 1;

export function resolutionHours(teamId: TeamId, priority: Priority): number {
  return (
    TEAM_RESOLUTION_HOURS[teamId]?.[priority] ??
    DEFAULT_RESOLUTION_HOURS[priority]
  );
}

/** The clock starts at ticket creation, so slow triage counts against the SLA. */
export function computeDeadline(
  createdAt: string,
  teamId: TeamId,
  priority: Priority,
): string {
  const start = new Date(createdAt).getTime();
  return new Date(
    start + resolutionHours(teamId, priority) * 60 * 60 * 1000,
  ).toISOString();
}
