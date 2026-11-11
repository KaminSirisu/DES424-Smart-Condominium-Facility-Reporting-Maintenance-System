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
 * category, priority, teamId, deadlineAt, completedAt,
 * mergedIntoTicketId are all absent until a later step (triage, status
 * change, merge) sets them.
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
  priority?: Priority;
  teamId?: string;
  /**
   * Who decided `priority`: 'AI' for the automatic triage (including the
   * safety override), 'STAFF' once a person changes it. Part of the Ticket
   * schema in openapi.yaml.
   */
  prioritySetBy?: 'AI' | 'STAFF';
  /** Set when the safety override (SLA-02) raised the priority to CRITICAL. */
  safetyHazard?: string;
  deadlineAt?: string;
  /**
   * When the current SLA clock started, when that is not `createdAt`: a merge
   * sets it to the earlier start of a ticket merged into this one (SLA-09), and
   * a reopen sets it to the time of the reopen (SLA-10). Internal; see
   * slaStartOf() in triage/policy.ts.
   */
  slaStartAt?: string;
  /**
   * A hash of the Idempotency-Key of the last reopen, so a retry of that
   * request is recognised and changes nothing. Internal.
   */
  reopenKey?: string;
  /**
   * SLA alerts already raised for the current SLA clock (requirements 3.7), one
   * conditional write each so an alert is raised once. A reopen removes all of
   * them with the new clock. Internal.
   *
   * `slaTriageDelayedAt`: the ticket was still RECEIVED, not triaged, after
   * the triage delay (SLA-06); a ticket is never RECEIVED again, so it is
   * raised once and never cleared.
   * `slaWarnedAt`: 75% of the resolution time was used (E0).
   * `slaResponseBreachedAt`: the response target passed while the ticket was
   * still ASSIGNED (E1).
   * `slaBreachedAt`: the resolution deadline passed (E2); `slaBreachAlerts` is
   * how many E2 alerts were raised (the first, then a CRITICAL ticket's hourly
   * reminders) and `slaLastBreachAlertAt` when the last one was.
   */
  slaTriageDelayedAt?: string;
  slaWarnedAt?: string;
  slaResponseBreachedAt?: string;
  slaBreachedAt?: string;
  slaBreachAlerts?: number;
  slaLastBreachAlertAt?: string;
  completedAt?: string;
  /**
   * When the repair was last finished: set when the ticket becomes DONE and
   * kept when it is reopened, while `completedAt` is removed (it is present
   * only while the current cycle is DONE). Internal; the dashboard history
   * reports it.
   */
  lastCompletedAt?: string;
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
    /** Extra response headers, such as Retry-After on a 429. */
    public readonly headers: Record<string, string> = {},
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
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  fromPriority?: Priority;
  toPriority?: Priority;
  fromTeamId?: string;
  toTeamId?: string;
  /** The staff account that did it (openapi TicketEvent.actorStaffId). */
  actorStaffId?: string;
  /** The team of the technician account that did it (SR-11); not set for a manager. */
  actorTeamId?: string;
  /** The REPAIR_PROOF photo that allowed the DONE status. */
  proofPhotoId?: string;
  /** Why the change was made, when it was not an ordinary one (openapi TicketEvent.note). */
  note?: string;
  repairCycle?: number;
}

/**
 * An SLA alert the sweep found due for a ticket (requirements 3.7):
 * TRIAGE_DELAYED (still RECEIVED after the triage delay, SLA-06), WARNING (E0), RESPONSE_BREACH (E1) or RESOLUTION_BREACH (E2). For the last,
 * `sent` is how many E2 alerts the ticket already had: 0 for the first, then
 * the count so far for a reminder.
 */
export type SlaAlert =
  | { kind: 'TRIAGE_DELAYED' }
  | { kind: 'WARNING' }
  | { kind: 'RESPONSE_BREACH' }
  | { kind: 'RESOLUTION_BREACH'; sent: number };
