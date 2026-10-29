import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
  applyTriage: vi.fn(),
}));
vi.mock('../../backend/src/triage/classifier', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../backend/src/triage/classifier')
  >()),
  classifyTicket: vi.fn(),
}));

import { handler, triageTicket } from '../../backend/src/triage/triage-handler';
import {
  ClassifierError,
  classifyTicket,
} from '../../backend/src/triage/classifier';
import {
  applyTriage,
  getTicket,
} from '../../backend/src/shared/ticket-repository';

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'RECEIVED',
    repairCycle: 1,
    photos: [],
    version: 1,
    reporterLineUserId: 'Uabc123',
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

function record(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  entityType: string,
  id: string,
  sequence: string,
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: { entityType: { S: entityType }, id: { S: id } },
    },
  };
}

function eventOf(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

const classification = {
  category: 'PLUMBING',
  impact: 'HIGH',
  urgency: 'MEDIUM',
};

describe('triage stream handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(classifyTicket).mockResolvedValue(classification);
    vi.mocked(applyTriage).mockResolvedValue(undefined);
  });

  it('triages a newly inserted ticket', async () => {
    const result = await handler(
      eventOf(record('INSERT', 'TICKET', 'tkt_1', '1')),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(classifyTicket).toHaveBeenCalledOnce();
    expect(applyTriage).toHaveBeenCalledWith(
      'tkt_1',
      1,
      expect.objectContaining({ priority: 'CRITICAL', teamId: 'PLUMBING' }),
    );
  });

  it('runs triage once for the three items written per ticket', async () => {
    await handler(
      eventOf(
        record('INSERT', 'TICKET', 'tkt_1', '1'),
        record('INSERT', 'TICKET_REPORTER', 'tkt_1', '2'),
        record('INSERT', 'TICKET_EVENT', 'tkt_1_created', '3'),
      ),
    );
    expect(classifyTicket).toHaveBeenCalledOnce();
    expect(applyTriage).toHaveBeenCalledOnce();
  });

  it.each([
    ['a MODIFY of a ticket', record('MODIFY', 'TICKET', 'tkt_1', '1')],
    ['a REMOVE of a ticket', record('REMOVE', 'TICKET', 'tkt_1', '1')],
    ['an INSERT without an image', { eventName: 'INSERT' } as DynamoDBRecord],
  ])('ignores %s', async (_label, rec) => {
    const result = await handler(eventOf(rec));
    expect(result).toEqual({ batchItemFailures: [] });
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('skips the AI call for a ticket that is no longer RECEIVED', async () => {
    vi.mocked(getTicket).mockResolvedValue(ticket({ status: 'ASSIGNED' }));
    await expect(triageTicket('tkt_1')).resolves.toBe('ALREADY_TRIAGED');
    expect(classifyTicket).not.toHaveBeenCalled();
    expect(applyTriage).not.toHaveBeenCalled();
  });

  it('leaves the ticket RECEIVED and moves on after an unusable AI reply', async () => {
    vi.mocked(classifyTicket)
      .mockRejectedValueOnce(
        new ClassifierError('UNPARSEABLE_RESPONSE', 'not json'),
      )
      .mockResolvedValueOnce(classification);
    vi.mocked(getTicket)
      .mockResolvedValueOnce(ticket({ id: 'tkt_1' }))
      .mockResolvedValueOnce(ticket({ id: 'tkt_2' }));

    const result = await handler(
      eventOf(
        record('INSERT', 'TICKET', 'tkt_1', '1'),
        record('INSERT', 'TICKET', 'tkt_2', '2'),
      ),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(applyTriage).toHaveBeenCalledOnce();
    expect(vi.mocked(applyTriage).mock.calls[0][0]).toBe('tkt_2');
  });

  it('does not retry a ticket that was invalid or missing', async () => {
    vi.mocked(classifyTicket).mockResolvedValue({
      category: 'ROOFING',
      impact: 'HIGH',
      urgency: 'HIGH',
    });
    const invalid = await handler(
      eventOf(record('INSERT', 'TICKET', 'tkt_1', '1')),
    );
    expect(invalid).toEqual({ batchItemFailures: [] });

    vi.mocked(getTicket).mockResolvedValue(null);
    const missing = await handler(
      eventOf(record('INSERT', 'TICKET', 'tkt_9', '2')),
    );
    expect(missing).toEqual({ batchItemFailures: [] });
    expect(applyTriage).not.toHaveBeenCalled();
  });

  it('reports a temporary failure and stops so Lambda retries from there', async () => {
    vi.mocked(classifyTicket).mockRejectedValue(new Error('throttled'));

    const result = await handler(
      eventOf(
        record('INSERT', 'TICKET', 'tkt_1', '10'),
        record('INSERT', 'TICKET', 'tkt_2', '11'),
      ),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(getTicket).toHaveBeenCalledOnce();
  });

  it('rethrows a temporary failure when the record has no sequence number', async () => {
    vi.mocked(classifyTicket).mockRejectedValue(new Error('throttled'));
    const rec = record('INSERT', 'TICKET', 'tkt_1', '1');
    delete rec.dynamodb?.SequenceNumber;

    await expect(handler(eventOf(rec))).rejects.toThrow('throttled');
  });
});
