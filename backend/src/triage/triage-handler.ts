import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { getTicket } from '../shared/ticket-repository';
import { TriageError, applyClassification } from './apply-classification';
import type { TriageOutcome } from './apply-classification';
import { ClassifierError, classifyTicket } from './classifier';

/**
 * AI triage worker (SCFRMS-41), triggered by the table's DynamoDB Stream.
 *
 * Creating a ticket writes three items (ticket, reporter association, audit
 * event), so the stream carries three INSERTs per ticket; only the one with
 * entityType TICKET starts triage. Later changes to the ticket (MODIFY) are
 * ignored, which also stops the triage update from re-triggering itself.
 *
 * Failures:
 *  - Permanent (unusable AI reply, missing ticket): logged, no retry. The
 *    ticket stays RECEIVED and shows up in GET /tickets?status=RECEIVED for
 *    manual triage.
 *  - Temporary (Bedrock throttling, DynamoDB errors): reported as a partial
 *    batch failure so Lambda retries from that record. Needs
 *    ReportBatchItemFailures on the event source mapping, a stream view of
 *    NEW_IMAGE or NEW_AND_OLD_IMAGES, and a bounded retry count.
 */

/** The ticket id of a newly created ticket, or null for any other record. */
function newTicketId(record: DynamoDBRecord): string | null {
  if (record.eventName !== 'INSERT') return null;
  const image = record.dynamodb?.NewImage;
  if (image?.entityType?.S !== 'TICKET') return null;
  return image.id?.S ?? null;
}

function isPermanentFailure(err: unknown): boolean {
  return err instanceof TriageError || err instanceof ClassifierError;
}

/** Classifies one ticket and applies the result. Safe to run more than once. */
export async function triageTicket(ticketId: string): Promise<TriageOutcome> {
  const ticket = await getTicket(ticketId);
  if (!ticket) {
    throw new TriageError('TICKET_NOT_FOUND', `Ticket ${ticketId} not found.`);
  }
  // Skip the AI call entirely for a ticket that was already triaged.
  if (ticket.status !== 'RECEIVED') return 'ALREADY_TRIAGED';

  const classification = await classifyTicket(ticket);
  return applyClassification(ticketId, classification);
}

export async function handler(
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> {
  for (const record of event.Records) {
    const ticketId = newTicketId(record);
    if (!ticketId) continue;

    try {
      const outcome = await triageTicket(ticketId);
      console.info('Triage finished', { ticketId, outcome });
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.error('Triage failed; ticket stays RECEIVED', {
          ticketId,
          err,
        });
        continue;
      }

      console.error('Triage failed; will retry', { ticketId, err });
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (!sequenceNumber) throw err;
      // Lambda retries this record and every record after it.
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
    }
  }
  return { batchItemFailures: [] };
}
