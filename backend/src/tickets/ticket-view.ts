import type { StoredTicketPhoto, TicketPhoto, TicketRecord } from './types.js';

/**
 * The caller-safe view of a ticket: what an API response may contain.
 *
 * An allowlist, not a denylist: records read back from DynamoDB carry
 * internal fields (version, photo S3 keys, reporterLineUserId, safetyHazard)
 * that must never reach a caller. The audience is required, so every response
 * has to decide who is asking:
 *
 *  - a REPORTER never sees `acceptedByStaffId` (staff-visible only in
 *    openapi.yaml, and RR-04: no staff identities for reporters);
 *  - STAFF see it.
 */

export type ViewAudience = 'REPORTER' | 'STAFF';

// `photos` is added separately so S3 keys never leak.
const COMMON_FIELDS = [
  'id',
  'location',
  'description',
  'status',
  'repairCycle',
  'category',
  'suggestedPriority',
  'priority',
  'prioritySetBy',
  'teamId',
  'acceptedAt',
  'deadlineAt',
  'completedAt',
  'mergedIntoTicketId',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof TicketRecord)[];

const STAFF_ONLY_FIELDS = [
  'acceptedByStaffId',
] as const satisfies readonly (keyof TicketRecord)[];

/** Caller-visible photo metadata only — never the private S3 key. */
function toPhotoView(photo: StoredTicketPhoto): TicketPhoto {
  const view: TicketPhoto = {
    id: photo.id,
    purpose: photo.purpose,
    addedAt: photo.addedAt,
  };
  if (photo.repairCycle !== undefined) view.repairCycle = photo.repairCycle;
  return view;
}

export function toTicketView(
  record: TicketRecord,
  audience: ViewAudience,
): Record<string, unknown> {
  const fields: readonly (keyof TicketRecord)[] =
    audience === 'STAFF'
      ? [...COMMON_FIELDS, ...STAFF_ONLY_FIELDS]
      : COMMON_FIELDS;

  const view: Record<string, unknown> = {};
  for (const field of fields) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  view.photos = record.photos.map(toPhotoView);
  return view;
}
