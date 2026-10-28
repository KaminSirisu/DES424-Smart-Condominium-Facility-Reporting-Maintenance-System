/**
 * Shared types for the tickets module (SCFRMS-40: ticket creation).
 *
 * Design: a reporter submits a defect report through LIFF. The backend
 * verifies their LINE identity server-side (see shared/line-token.ts) —
 * never trusts a LINE user ID supplied by the client. A new ticket is
 * always stored with status RECEIVED and no category/priority/teamId/
 * deadlineAt; those are set later by the AI classification step
 * (SCFRMS-41), not by this endpoint. See docs/api-specs/openapi.yaml
 * (Ticket, CreateTicket schemas) for the approved contract.
 */

export type TicketStatus =
  'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'MERGED';

export type PhotoPurpose = 'DEFECT' | 'REPAIR_PROOF';

export type Priority = 'CRITICAL' | 'MEDIUM' | 'LOW';

/** Caller-visible metadata for a stored ticket photo (never the S3 key itself). */
export interface TicketPhoto {
  id: string;
  purpose: PhotoPurpose;
  addedAt: string;
  /** Present for a REPAIR_PROOF photo from a specific repair cycle. */
  repairCycle?: number;
}

/** A photo as stored: TicketPhoto plus its private S3 key, which must never reach a caller. */
export interface StoredTicketPhoto extends TicketPhoto {
  s3ObjectKey: string;
}

/**
 * The Ticket entity's domain shape, as stored in DynamoDB.
 *
 * `reporterLineUserId` is internal-only: it identifies which reporter may
 * see/reopen this ticket, but must never appear in an API response (the
 * caller-safe view is `toTicketView()` — see create-ticket.ts). Everything
 * else here matches the `Ticket` schema in openapi.yaml.
 *
 * On creation (this module), only id/location/description/status/
 * repairCycle/photos/reporterLineUserId/createdAt/updatedAt are set.
 * category, suggestedPriority, priority, teamId, acceptedByStaffId,
 * acceptedAt, deadlineAt, completedAt, mergedIntoTicketId are all absent
 * until a later step (triage, acceptance, status change, merge) sets them.
 */
export interface TicketRecord {
  id: string;
  /** Reporter-entered free text; no location ID or catalog lookup. */
  location: string;
  description: string;
  status: TicketStatus;
  /** Starts at 1; increments each time a completed ticket is reopened. */
  repairCycle: number;
  photos: StoredTicketPhoto[];
  /** Optimistic-locking counter: starts at 1, incremented on every update. */
  version: number;

  /** Never exposed to callers — see toTicketView(). */
  reporterLineUserId: string;

  category?: string;
  suggestedPriority?: Priority;
  priority?: Priority;
  teamId?: string;
  acceptedByStaffId?: string;
  acceptedAt?: string;
  deadlineAt?: string;
  completedAt?: string;
  mergedIntoTicketId?: string;

  createdAt: string;
  updatedAt: string;
}

/** The request body for POST /tickets, matching the CreateTicket schema. */
export interface CreateTicketInput {
  location: string;
  description: string;
  defectPhotoUploadId: string;
}

/** The verified caller identity derived from the LINE token (see line-token.ts). */
export interface AuthenticatedReporter {
  lineUserId: string;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A stored audit event (subset of the TicketEvent schema in openapi.yaml). */
export interface TicketEventRecord {
  id: string;
  ticketId: string;
  kind: string;
  occurredAt: string;
  actorType: 'REPORTER' | 'STAFF' | 'SYSTEM';
  toStatus?: TicketStatus;
  repairCycle?: number;
}
