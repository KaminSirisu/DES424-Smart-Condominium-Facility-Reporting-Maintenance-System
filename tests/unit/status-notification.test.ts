import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  listReporterIds: vi.fn(),
}));
vi.mock('../../backend/src/notifications/notification-log', () => ({
  hasSent: vi.fn(),
  markSent: vi.fn(),
}));
vi.mock('../../backend/src/notifications/work-order-email', () => ({
  sendWorkOrderEmail: vi.fn(),
}));
vi.mock('../../backend/src/notifications/line-messenger', async (original) => ({
  ...(await original<
    typeof import('../../backend/src/notifications/line-messenger')
  >()),
  lineSender: { push: vi.fn() },
}));

import { handler } from '../../backend/src/notifications/notification-handler';
import { getTicket } from '../../backend/src/shared/ticket-repository';
import { listReporterIds } from '../../backend/src/shared/ticket-reporters';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';
import { sendWorkOrderEmail } from '../../backend/src/notifications/work-order-email';
import { lineSender } from '../../backend/src/notifications/line-messenger';

/**
 * The real stream handler with the real LINE channel; only the edges (the
 * ticket and reporter reads, the notification log, LINE and email) are fakes.
 */
const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'IN_PROGRESS',
  repairCycle: 1,
  photos: [],
  version: 5,
  reporterLineUserId: 'Uaaa',
  teamId: 'PLUMBING',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
};

function statusRecord(
  toStatus: string | undefined,
  kind = 'STATUS_CHANGED',
  eventId = `tkt_1_status_v${ticket.version}`,
): DynamoDBStreamEvent {
  const record: DynamoDBRecord = {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: '1',
      NewImage: {
        ticketId: { S: 'tkt_1' },
        id: { S: eventId },
        kind: { S: kind },
        ...(toStatus ? { toStatus: { S: toStatus } } : {}),
      },
    },
  };
  return { Records: [record] };
}

const push = vi.mocked(lineSender.push);

describe('status change notifications', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(listReporterIds).mockResolvedValue(['Uaaa', 'Ubbb']);
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    push.mockResolvedValue(undefined);
  });

  it('tells every reporter that work started, and sends no email', async () => {
    const result = await handler(statusRecord('IN_PROGRESS'));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls.map((call) => call[0]).sort()).toEqual([
      'Uaaa',
      'Ubbb',
    ]);
    expect(push.mock.calls[0][1][0].altText).toContain('Work started');
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(
      vi.mocked(markSent).mock.calls.map((call) => call.slice(0, 3)),
    ).toEqual([
      ['tkt_1', 'tkt_1_status_v5', 'LINE_REPORTER:Uaaa'],
      ['tkt_1', 'tkt_1_status_v5', 'LINE_REPORTER:Ubbb'],
    ]);
  });

  it('tells every reporter that the repair is completed', async () => {
    await handler(statusRecord('DONE'));

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][1][0].altText).toContain('Repair completed');
  });

  it('sends nothing twice when the same event is delivered again', async () => {
    vi.mocked(hasSent).mockResolvedValue(true);

    await handler(statusRecord('DONE'));

    expect(push).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('sends nothing for an event kind it has no message for', async () => {
    await handler(
      statusRecord(undefined, 'PRIORITY_CHANGED', 'tkt_1_priority_v4'),
    );

    expect(push).not.toHaveBeenCalled();
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('sends nothing for a status change without a known target status', async () => {
    await handler(statusRecord(undefined));

    expect(push).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('retries from the record when LINE is temporarily down', async () => {
    push.mockRejectedValue(new Error('LINE is down'));

    const result = await handler(statusRecord('DONE'));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
    expect(markSent).not.toHaveBeenCalled();
  });
});
