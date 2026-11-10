import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  isReporterOf,
  listReporterIds,
} from '../../backend/src/shared/ticket-reporters.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

describe('listReporterIds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TICKET_REPORTERS_TABLE_NAME', 'TestReporters');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the LINE user id of every reporter, read with strong consistency', async () => {
    send.mockResolvedValue({
      Items: [
        { ticketId: 'tkt_1', reporterLineUserId: 'Uaaa' },
        { ticketId: 'tkt_1', reporterLineUserId: 'Ubbb' },
      ],
    });

    await expect(listReporterIds('tkt_1')).resolves.toEqual(['Uaaa', 'Ubbb']);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: 'TestReporters',
      KeyConditionExpression: 'ticketId = :ticketId',
      ExpressionAttributeValues: { ':ticketId': 'tkt_1' },
      ConsistentRead: true,
    });
  });

  it('follows the query across pages', async () => {
    send
      .mockResolvedValueOnce({
        Items: [{ reporterLineUserId: 'Uaaa' }],
        LastEvaluatedKey: { ticketId: 'tkt_1', reporterLineUserId: 'Uaaa' },
      })
      .mockResolvedValueOnce({ Items: [{ reporterLineUserId: 'Ubbb' }] });

    await expect(listReporterIds('tkt_1')).resolves.toEqual(['Uaaa', 'Ubbb']);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      ticketId: 'tkt_1',
      reporterLineUserId: 'Uaaa',
    });
  });

  it('skips items without a LINE user id and copes with no items', async () => {
    send.mockResolvedValueOnce({
      Items: [{ ticketId: 'tkt_1' }, { reporterLineUserId: 42 }],
    });
    await expect(listReporterIds('tkt_1')).resolves.toEqual([]);

    send.mockResolvedValueOnce({});
    await expect(listReporterIds('tkt_1')).resolves.toEqual([]);
  });

  it('fails clearly when the table name is not set', async () => {
    vi.stubEnv('TICKET_REPORTERS_TABLE_NAME', '');
    await expect(listReporterIds('tkt_1')).rejects.toThrow(
      'TICKET_REPORTERS_TABLE_NAME environment variable is not set.',
    );
  });
});

describe('isReporterOf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TICKET_REPORTERS_TABLE_NAME', 'TestReporters');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is true when the reporter has an item for the ticket, read with strong consistency', async () => {
    send.mockResolvedValue({
      Item: { ticketId: 'tkt_1', reporterLineUserId: 'Uaaa' },
    });

    await expect(isReporterOf('tkt_1', 'Uaaa')).resolves.toBe(true);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestReporters',
      Key: { ticketId: 'tkt_1', reporterLineUserId: 'Uaaa' },
      ConsistentRead: true,
    });
  });

  it('is false when there is no item', async () => {
    send.mockResolvedValue({});
    await expect(isReporterOf('tkt_1', 'Ubbb')).resolves.toBe(false);
  });
});
