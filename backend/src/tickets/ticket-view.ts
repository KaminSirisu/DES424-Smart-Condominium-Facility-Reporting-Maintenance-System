import type { StoredTicketPhoto, TicketPhoto, TicketRecord } from './types.js';

/**
 * The caller-safe view of a ticket: what an API response may contain.
 *
 * An allowlist, not a denylist: records read back from DynamoDB carry
 * internal fields (version, photo S3 keys, reporterLineUserId, safetyHazard)
 * that must never reach a caller, so a field appears only if it is listed
 * here. Every field listed is part of the `Ticket` schema in openapi.yaml.
 */

// `photos` is added separately so S3 keys never leak.
const VISIBLE_FIELDS = [
  'id',
  'location',
  'description',
  'status',
  'repairCycle',
  'category',
  'priority',
  'prioritySetBy',
  'teamId',
  'deadlineAt',
  'completedAt',
  'mergedIntoTicketId',
  'createdAt',
  'updatedAt',
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

export function toTicketView(record: TicketRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of VISIBLE_FIELDS) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  view.photos = record.photos.map(toPhotoView);
  return view;
}
