import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
}));
vi.mock('../../backend/src/shared/ticket-reporters', () => ({
  listReporterIds: vi.fn(),
}));
vi.mock('../../backend/src/shared/proof-photo', () => ({
  proofPhotoUrl: vi.fn(),
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
import { proofPhotoUrl } from '../../backend/src/shared/proof-photo';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';
import { lineSender } from '../../backend/src/notifications/line-messenger';

/**
 * The completion notice with the repair photo: the real stream handler and
 * the real LINE channel; the photo link, LINE and the data reads are fakes.
 */
const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'DONE',
  repairCycle: 1,
  photos: [
    {
      id: 'proof_1',
      purpose: 'REPAIR_PROOF',
      addedAt: '2026-11-05T11:00:00.000Z',
      repairCycle: 1,
      s3ObjectKey: 'uploads/REPAIR_PROOF/acct_plumbing/proof_1',
    },
  ],
  version: 6,
  reporterLineUserId: 'Uaaa',
  teamId: 'PLUMBING',
  acceptedByStaffId: 'acct_plumbing',
  completedAt: '2026-11-05T11:00:00.000Z',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
};

const PHOTO_URL = 'https://signed.example/thumb.jpg?sig=abc';

function statusEvent(
  toStatus: string,
  proofPhotoId?: string,
): DynamoDBStreamEvent {
  const record: DynamoDBRecord = {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: '1',
      NewImage: {
        ticketId: { S: 'tkt_1' },
        id: { S: 'tkt_1_status_v6' },
        kind: { S: 'STATUS_CHANGED' },
        toStatus: { S: toStatus },
        ...(proofPhotoId ? { proofPhotoId: { S: proofPhotoId } } : {}),
      },
    },
  };
  return { Records: [record] };
}

const push = vi.mocked(lineSender.push);
const sentMessage = (call: number) =>
  JSON.stringify(push.mock.calls[call][1][0]);

describe('completion notice with the repair photo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getTicket).mockResolvedValue(ticket);
    vi.mocked(listReporterIds).mockResolvedValue(['Uaaa', 'Ubbb']);
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    vi.mocked(proofPhotoUrl).mockResolvedValue(PHOTO_URL);
    push.mockResolvedValue(undefined);
  });

  it('shows the photo of the event to every reporter', async () => {
    const result = await handler(statusEvent('DONE', 'proof_1'));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(proofPhotoUrl).toHaveBeenCalledWith(ticket, 'proof_1');
    expect(push).toHaveBeenCalledTimes(2);
    expect(sentMessage(0)).toContain(`"url":"${PHOTO_URL}"`);
    expect(sentMessage(1)).toContain(`"url":"${PHOTO_URL}"`);
  });

  it('sends the notice without the photo when no link can be made', async () => {
    vi.mocked(proofPhotoUrl).mockResolvedValue(null);

    await handler(statusEvent('DONE', 'proof_1'));

    expect(push).toHaveBeenCalledTimes(2);
    expect(sentMessage(0)).toContain('Repair completed');
    expect(sentMessage(0)).not.toContain('"hero"');
  });

  it('sends the notice without the photo when making the link fails', async () => {
    vi.mocked(proofPhotoUrl).mockRejectedValue(new Error('S3 is down'));

    const result = await handler(statusEvent('DONE', 'proof_1'));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(push).toHaveBeenCalledTimes(2);
    expect(sentMessage(0)).not.toContain('"hero"');
    expect(console.error).toHaveBeenCalledWith(
      'Proof photo link failed; sending without the photo',
      expect.objectContaining({ ticketId: 'tkt_1' }),
    );
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('Uaaa');
  });

  it('does not make a photo link for an event without a photo', async () => {
    await handler(statusEvent('DONE'));

    expect(proofPhotoUrl).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('does not make a photo link when work starts', async () => {
    await handler(statusEvent('IN_PROGRESS', 'proof_1'));

    expect(proofPhotoUrl).not.toHaveBeenCalled();
    expect(sentMessage(0)).toContain('Work started');
  });
});
