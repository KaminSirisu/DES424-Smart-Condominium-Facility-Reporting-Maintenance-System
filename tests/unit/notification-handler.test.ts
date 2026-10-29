import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
}));
vi.mock('../../backend/src/notifications/notification-log', () => ({
  hasSent: vi.fn(),
  markSent: vi.fn(),
}));
vi.mock('../../backend/src/notifications/work-order-email', () => ({
  sendWorkOrderEmail: vi.fn(),
}));

import { handler } from '../../backend/src/notifications/notification-handler';
import { getTicket } from '../../backend/src/shared/ticket-repository';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';
import { sendWorkOrderEmail } from '../../backend/src/notifications/work-order-email';

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uabc123',
    category: 'PLUMBING',
    priority: 'CRITICAL',
    teamId: 'PLUMBING',
    deadlineAt: '2026-10-29T07:00:00.000Z',
    createdAt: '2026-10-29T03:00:00.000Z',
    updatedAt: '2026-10-29T03:01:00.000Z',
    ...overrides,
  };
}

function record(
  entityType: string,
  kind: string,
  sequence: string,
  eventName: 'INSERT' | 'MODIFY' = 'INSERT',
  eventId = 'tkt_1_triaged',
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: {
        entityType: { S: entityType },
        ticketId: { S: 'tkt_1' },
        id: { S: eventId },
        kind: { S: kind },
      },
    },
  };
}

function eventOf(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

const triaged = (sequence = '1') => record('TICKET_EVENT', 'TRIAGED', sequence);

describe('notification stream handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('SENT');
  });

  it('emails the team when a ticket is triaged and records it', async () => {
    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(hasSent).toHaveBeenCalledWith(
      'tkt_1',
      'tkt_1_triaged',
      'EMAIL_TEAM',
    );
    expect(sendWorkOrderEmail).toHaveBeenCalledWith(ticket());
    expect(markSent).toHaveBeenCalledWith(
      'tkt_1',
      'tkt_1_triaged',
      'EMAIL_TEAM',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it.each([
    ['a TICKET_CREATED event', record('TICKET_EVENT', 'TICKET_CREATED', '1')],
    ['a ticket item', record('TICKET', 'TRIAGED', '1')],
    ['a reporter link', record('TICKET_REPORTER', 'TRIAGED', '1')],
    ['a notification record', record('TICKET_NOTIFICATION', 'TRIAGED', '1')],
    ['a MODIFY of an event', record('TICKET_EVENT', 'TRIAGED', '1', 'MODIFY')],
    ['a record without an image', { eventName: 'INSERT' } as DynamoDBRecord],
  ])('ignores %s', async (_label, rec) => {
    const result = await handler(eventOf(rec));
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('does not send again for an event that was already handled', async () => {
    vi.mocked(hasSent).mockResolvedValue(true);

    await handler(eventOf(triaged()));

    expect(getTicket).not.toHaveBeenCalled();
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('does not record anything when no email was sent', async () => {
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('NO_RECIPIENT');

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(markSent).not.toHaveBeenCalled();
  });

  it('logs and moves on when the ticket no longer exists', async () => {
    vi.mocked(getTicket).mockResolvedValue(null);

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
  });

  it('handles every event in a batch', async () => {
    await handler(
      eventOf(
        triaged('1'),
        record('TICKET_EVENT', 'TRIAGED', '2', 'INSERT', 'tkt_2_triaged'),
      ),
    );
    expect(sendWorkOrderEmail).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledTimes(2);
  });

  it('reports a temporary failure and stops so Lambda retries from there', async () => {
    vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('throttled'));

    const result = await handler(
      eventOf(
        triaged('10'),
        record('TICKET_EVENT', 'TRIAGED', '11', 'INSERT', 'tkt_2_triaged'),
      ),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(sendWorkOrderEmail).toHaveBeenCalledOnce();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('retries when recording the send fails, rather than losing the record', async () => {
    vi.mocked(markSent).mockRejectedValue(new Error('dynamo down'));

    const result = await handler(eventOf(triaged('7')));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '7' }] });
  });

  it('rethrows a temporary failure when the record has no sequence number', async () => {
    vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('throttled'));
    const rec = triaged();
    delete rec.dynamodb?.SequenceNumber;

    await expect(handler(eventOf(rec))).rejects.toThrow('throttled');
  });
});
