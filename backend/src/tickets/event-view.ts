import type { TicketEventRecord } from './types.js';

/**
 * The caller-safe view of an audit event: what an API response may contain.
 *
 * An allowlist, like ticket-view.ts: a field appears only if it is listed
 * here, so the storage key and anything added to the record later stay
 * inside. Every field listed is part of the `TicketEvent` schema in
 * openapi.yaml.
 */
const VISIBLE_FIELDS = [
  'id',
  'ticketId',
  'kind',
  'occurredAt',
  'actorType',
  'actorStaffId',
  'actorTeamId',
  'fromStatus',
  'toStatus',
  'fromPriority',
  'toPriority',
  'fromTeamId',
  'toTeamId',
  'repairCycle',
  'proofPhotoId',
  'note',
] as const satisfies readonly (keyof TicketEventRecord)[];

export function toEventView(
  record: TicketEventRecord,
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of VISIBLE_FIELDS) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  return view;
}
