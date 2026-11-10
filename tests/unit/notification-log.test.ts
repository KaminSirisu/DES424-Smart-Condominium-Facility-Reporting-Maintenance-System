import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

describe('notification log', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NOTIFICATIONS_TABLE_NAME', 'TestNotifications');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports a notification as sent when its record exists', async () => {
    send.mockResolvedValue({ Item: { ticketId: 'tkt_1' } });
    await expect(hasSent('tkt_1', 'tkt_1_triaged', 'EMAIL_TEAM')).resolves.toBe(
      true,
    );
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestNotifications',
      Key: {
        ticketId: 'tkt_1',
        notificationKey: 'tkt_1_triaged#EMAIL_TEAM',
      },
    });
  });

  it('reports a notification as not sent when no record exists', async () => {
    send.mockResolvedValue({});
    await expect(hasSent('tkt_1', 'tkt_1_triaged', 'EMAIL_TEAM')).resolves.toBe(
      false,
    );
  });

  it('writes a conditional record when marking as sent', async () => {
    send.mockResolvedValue({});
    await markSent(
      'tkt_1',
      'tkt_1_triaged',
      'EMAIL_TEAM',
      '2026-10-29T10:00:00.000Z',
    );

    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestNotifications',
      Item: {
        ticketId: 'tkt_1',
        notificationKey: 'tkt_1_triaged#EMAIL_TEAM',
        eventId: 'tkt_1_triaged',
        channel: 'EMAIL_TEAM',
        sentAt: '2026-10-29T10:00:00.000Z',
      },
      ConditionExpression: 'attribute_not_exists(ticketId)',
    });
  });

  it('ignores a record that already exists', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('exists'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    await expect(
      markSent(
        'tkt_1',
        'tkt_1_triaged',
        'EMAIL_TEAM',
        '2026-10-29T10:00:00.000Z',
      ),
    ).resolves.toBeUndefined();
  });

  it('rethrows any other write failure', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(
      markSent(
        'tkt_1',
        'tkt_1_triaged',
        'EMAIL_TEAM',
        '2026-10-29T10:00:00.000Z',
      ),
    ).rejects.toThrow('throttled');
  });

  it('fails clearly when the table name is not set', async () => {
    vi.stubEnv('NOTIFICATIONS_TABLE_NAME', '');
    await expect(hasSent('tkt_1', 'e', 'c')).rejects.toThrow(
      'NOTIFICATIONS_TABLE_NAME environment variable is not set.',
    );
  });
});
