import { applyTriage, getTicket } from '../shared/ticket-repository';
import {
  SLA_POLICY_VERSION,
  TEAM_FOR_CATEGORY,
  computeDeadline,
  isCategory,
  isLevel,
  priorityFor,
} from './policy';

/**
 * Turns an AI classification into a stored triage result (SCFRMS-41).
 *
 * The AI only proposes {category, impact, urgency}. Everything that matters
 * is decided here in code: values outside the known enums are rejected,
 * priority comes from the impact × urgency matrix, the team from the
 * category, and the deadline from the SLA policy. Nothing the model says is
 * written to the database as-is.
 *
 * Failure policy (pending team confirmation): an unusable classification
 * leaves the ticket RECEIVED, so it stays visible to a manager through
 * GET /tickets?status=RECEIVED.
 */

export type TriageErrorCode = 'TICKET_NOT_FOUND' | 'INVALID_CLASSIFICATION';

export class TriageError extends Error {
  constructor(
    public readonly code: TriageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TriageError';
  }
}

export type TriageOutcome = 'APPLIED' | 'ALREADY_TRIAGED';

/** Same check as create-ticket.ts: item 0 of the transaction is the ticket. */
function isConditionalCheckFailure(err: unknown): boolean {
  const e = err as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  return (
    e?.name === 'TransactionCanceledException' &&
    e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
  );
}

export async function applyClassification(
  ticketId: string,
  classification: unknown,
  now: Date = new Date(),
): Promise<TriageOutcome> {
  const ticket = await getTicket(ticketId);
  if (!ticket) {
    throw new TriageError('TICKET_NOT_FOUND', `Ticket ${ticketId} not found.`);
  }
  // Streams and retries can deliver the same ticket twice; do nothing.
  if (ticket.status !== 'RECEIVED') return 'ALREADY_TRIAGED';

  const { category, impact, urgency } = (classification ?? {}) as Record<
    string,
    unknown
  >;
  if (!isCategory(category) || !isLevel(impact) || !isLevel(urgency)) {
    throw new TriageError(
      'INVALID_CLASSIFICATION',
      'Classification must contain a known category, impact and urgency.',
    );
  }

  const priority = priorityFor(impact, urgency);
  const teamId = TEAM_FOR_CATEGORY[category];

  try {
    await applyTriage(ticketId, ticket.version, {
      category,
      suggestedPriority: priority,
      priority,
      teamId,
      deadlineAt: computeDeadline(ticket.createdAt, teamId, priority),
      slaPolicyVersion: SLA_POLICY_VERSION,
      now: now.toISOString(),
    });
  } catch (err) {
    // Someone else triaged or changed the ticket between our read and write.
    if (isConditionalCheckFailure(err)) return 'ALREADY_TRIAGED';
    throw err;
  }
  return 'APPLIED';
}
