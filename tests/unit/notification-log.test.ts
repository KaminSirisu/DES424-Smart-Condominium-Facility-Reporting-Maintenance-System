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
    vi.stubEnv('TABLE_NAME', 'TestTable');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports a notification as sent when its record exists', async () => {
    send.mockResolvedValue({ Item: { PK: 'x' } });
    await expect(hasSent('tkt_1', 'tkt_1_triaged', 'EMAIL_TEAM')).resolves.toBe(
      true,
    );
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestTable',
      Key: {
        PK: 'TICKET#tkt_1',
        SK: 'NOTIFICATION#tkt_1_triaged#EMAIL_TEAM',
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
      TableName: 'TestTable',
      Item: {
        PK: 'TICKET#tkt_1',
        SK: 'NOTIFICATION#tkt_1_triaged#EMAIL_TEAM',
        entityType: 'TICKET_NOTIFICATION',
        ticketId: 'tkt_1',
        eventId: 'tkt_1_triaged',
        channel: 'EMAIL_TEAM',
        sentAt: '2026-10-29T10:00:00.000Z',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
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

  it('fails clearly when TABLE_NAME is not set', async () => {
    vi.stubEnv('TABLE_NAME', '');
    await expect(hasSent('tkt_1', 'e', 'c')).rejects.toThrow(
      'TABLE_NAME environment variable is not set.',
    );
  });
});
