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
vi.mock('../../backend/src/notifications/line-notification', () => ({
  lineReporterChannel: {
    name: 'LINE_REPORTER',
    kinds: ['CREATED', 'TRIAGED'],
    recipients: vi.fn(),
    send: vi.fn(),
  },
}));

import { handler } from '../../backend/src/notifications/notification-handler';
import { getTicket } from '../../backend/src/shared/ticket-repository';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';
import { sendWorkOrderEmail } from '../../backend/src/notifications/work-order-email';
import { lineReporterChannel } from '../../backend/src/notifications/line-notification';

const lineRecipients = vi.mocked(lineReporterChannel.recipients);
const lineSend = vi.mocked(lineReporterChannel.send);

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uaaa',
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
  kind: string,
  sequence: string,
  eventName: 'INSERT' | 'MODIFY' = 'INSERT',
  eventId = `tkt_1_${kind.toLowerCase()}`,
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: {
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

const triaged = (sequence = '1') => record('TRIAGED', sequence);
const created = (sequence = '1') => record('CREATED', sequence);

describe('notification stream handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('SENT');
    lineRecipients.mockResolvedValue(['Uaaa', 'Ubbb']);
    lineSend.mockResolvedValue(true);
  });

  it('emails the team and messages every reporter when a ticket is triaged', async () => {
    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).toHaveBeenCalledWith(ticket());
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(ticket(), 'Uaaa', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_triaged',
      kind: 'TRIAGED',
    });
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Ubbb',
      expect.objectContaining({ kind: 'TRIAGED' }),
    );
    expect(
      vi.mocked(markSent).mock.calls.map((call) => call.slice(0, 3)),
    ).toEqual([
      ['tkt_1', 'tkt_1_triaged', 'EMAIL_TEAM:PLUMBING'],
      ['tkt_1', 'tkt_1_triaged', 'LINE_REPORTER:Uaaa'],
      ['tkt_1', 'tkt_1_triaged', 'LINE_REPORTER:Ubbb'],
    ]);
    expect(markSent).toHaveBeenCalledWith(
      'tkt_1',
      'tkt_1_triaged',
      'EMAIL_TEAM:PLUMBING',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('sends only the LINE receipt when a ticket is created', async () => {
    await handler(eventOf(created()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Uaaa',
      expect.objectContaining({
        kind: 'CREATED',
        eventId: 'tkt_1_created',
      }),
    );
  });

  it.each([
    ['an event kind no channel handles', record('PRIORITY_CHANGED', '1')],
    ['a MODIFY of an event', record('TRIAGED', '1', 'MODIFY')],
    ['a record without an image', { eventName: 'INSERT' } as DynamoDBRecord],
    [
      'an event without a kind',
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: { ticketId: { S: 'tkt_1' }, id: { S: 'tkt_1_triaged' } },
        },
      } as DynamoDBRecord,
    ],
  ])('ignores %s', async (_label, rec) => {
    const result = await handler(eventOf(rec));
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('skips a recipient that already got the message and still messages the rest', async () => {
    vi.mocked(hasSent).mockImplementation(
      async (_ticketId, _eventId, key) =>
        key === 'EMAIL_TEAM:PLUMBING' || key === 'LINE_REPORTER:Uaaa',
    );

    await handler(eventOf(triaged()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(1);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Ubbb',
      expect.objectContaining({ kind: 'TRIAGED' }),
    );
    expect(markSent).toHaveBeenCalledTimes(1);
  });

  it('sends nothing again for an event that was fully handled', async () => {
    vi.mocked(hasSent).mockResolvedValue(true);

    await handler(eventOf(triaged()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('does not record a message that was not actually sent', async () => {
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('NO_RECIPIENT');
    lineSend.mockResolvedValue(false);

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(markSent).not.toHaveBeenCalled();
  });

  it('logs and moves on when the ticket no longer exists', async () => {
    vi.mocked(getTicket).mockResolvedValue(null);

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('handles every event in a batch', async () => {
    await handler(
      eventOf(
        created('1'),
        triaged('2'),
        record('TRIAGED', '3', 'INSERT', 'e3'),
      ),
    );
    // created: 2 LINE; triaged: 1 email + 2 LINE; third event: same keys but another event id
    expect(lineSend).toHaveBeenCalledTimes(6);
    expect(sendWorkOrderEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps the messages already sent when a later recipient fails, and retries from that record', async () => {
    lineSend.mockImplementation(async (_ticket, recipient) => {
      if (recipient === 'Ubbb') throw new Error('LINE is down');
      return true;
    });

    const result = await handler(
      eventOf(triaged('10'), record('TRIAGED', '11', 'INSERT', 'e2')),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    const recorded = vi.mocked(markSent).mock.calls.map((call) => call[2]);
    expect(recorded).toEqual(['EMAIL_TEAM:PLUMBING', 'LINE_REPORTER:Uaaa']);
    // the second event is left for the retry
    expect(getTicket).toHaveBeenCalledOnce();
  });

  it('reports a temporary email failure and stops so Lambda retries from there', async () => {
    vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('throttled'));

    const result = await handler(
      eventOf(triaged('10'), record('TRIAGED', '11', 'INSERT', 'e2')),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(sendWorkOrderEmail).toHaveBeenCalledOnce();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('retries when recording a send fails, rather than losing the record', async () => {
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

  it('never writes a recipient LINE user id to the logs (SR-35)', async () => {
    lineSend.mockRejectedValueOnce(new Error('LINE is down'));

    await handler(eventOf(triaged('5')));
    await handler(eventOf(created('6')));

    const logged = JSON.stringify([
      ...vi.mocked(console.info).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain('Uaaa');
    expect(logged).not.toContain('Ubbb');
    expect(logged).toContain('LINE_REPORTER');
  });
});
