import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  MAX_TRANSACTION_ITEMS,
  mergeItemCount,
  mergeTickets,
  type MergeChange,
} from '../../backend/src/shared/ticket-repository.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const NOW = '2026-11-06T09:00:00.000Z';

interface SentItem {
  TableName: string;
  Key?: Record<string, unknown>;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function items(): { Update?: SentItem; Put?: SentItem }[] {
  return send.mock.calls[0][0].input.TransactItems;
}

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_main',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 4,
    reporterLineUserId: 'Uaaa',
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
    ...overrides,
  };
}

const source1 = ticket({
  id: 'tkt_dup1',
  version: 2,
  reporterLineUserId: 'Ubbb',
});
const source2 = ticket({
  id: 'tkt_dup2',
  status: 'IN_PROGRESS',
  version: 5,
  reporterLineUserId: 'Uccc',
});

const change: MergeChange = {
  accountId: 'plumbing@example.com',
  teamId: 'PLUMBING',
  now: NOW,
  reporters: [
    { lineUserId: 'Ubbb', sourceTicketId: 'tkt_dup1' },
    { lineUserId: 'Uccc', sourceTicketId: 'tkt_dup2' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_EVENTS_TABLE_NAME', 'TestEvents');
  vi.stubEnv('TICKET_REPORTERS_TABLE_NAME', 'TestReporters');
  send.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe('mergeTickets', () => {
  it('writes the canonical update, its event, then each source and its event, then the reporters', async () => {
    await mergeTickets(ticket(), [source1, source2], change);

    const all = items();
    expect(all).toHaveLength(mergeItemCount(2, 2));
    expect(all.map((i) => (i.Update ? 'update' : 'put'))).toEqual([
      'update', // canonical first, so a lost race shows at index 0
      'put',
      'update',
      'put',
      'update',
      'put',
      'put',
      'put',
    ]);
    expect(all[0].Update?.Key).toEqual({ ticketId: 'tkt_main' });
    expect(all[2].Update?.Key).toEqual({ ticketId: 'tkt_dup1' });
    expect(all[4].Update?.Key).toEqual({ ticketId: 'tkt_dup2' });
  });

  it('bumps the canonical ticket only when it was in the status and version that were read', async () => {
    await mergeTickets(ticket(), [source1], { ...change, reporters: [] });

    const [update] = items();
    expect(update.Update?.ConditionExpression).toBe(
      '#status = :status AND #version = :version',
    );
    expect(update.Update?.UpdateExpression).toBe(
      'SET updatedAt = :now, #version = #version + :one',
    );
    expect(update.Update?.ExpressionAttributeValues).toEqual({
      ':status': 'ASSIGNED',
      ':version': 4,
      ':one': 1,
      ':now': NOW,
    });
  });

  it('raises the priority and moves the deadline of the canonical ticket when told to', async () => {
    await mergeTickets(ticket(), [source1], {
      ...change,
      reporters: [],
      priority: 'CRITICAL',
      deadlineAt: '2026-11-05T12:00:00.000Z',
    });

    const [update, event] = items();
    expect(update.Update?.UpdateExpression).toBe(
      'SET updatedAt = :now, #version = #version + :one, priority = :priority, deadlineAt = :deadlineAt',
    );
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':priority': 'CRITICAL',
      ':deadlineAt': '2026-11-05T12:00:00.000Z',
    });
    expect(event.Put?.Item).toMatchObject({
      toPriority: 'CRITICAL',
      note: 'Merged in #tkt_dup1; priority raised to CRITICAL',
    });
  });

  it('marks each source MERGED, points it at the canonical ticket and takes it out of the open queue', async () => {
    await mergeTickets(ticket(), [source1, source2], change);

    const update = items()[4].Update;
    expect(update?.ConditionExpression).toBe(
      '#status = :from AND #version = :version',
    );
    expect(update?.UpdateExpression).toContain('#status = :merged');
    expect(update?.UpdateExpression).toContain(
      'mergedIntoTicketId = :canonical',
    );
    expect(update?.UpdateExpression).toContain('REMOVE teamStatusKey');
    expect(update?.ExpressionAttributeValues).toEqual({
      ':from': 'IN_PROGRESS',
      ':version': 5,
      ':merged': 'MERGED',
      ':canonical': 'tkt_main',
      ':now': NOW,
      ':one': 1,
    });
  });

  it('writes a MERGED event on each source and DUPLICATES_MERGED on the canonical ticket', async () => {
    await mergeTickets(ticket(), [source1, source2], change);

    const all = items();
    expect(all[1].Put?.Item).toMatchObject({
      eventKey: `${NOW}#tkt_main_duplicates_merged_v5`,
      ticketId: 'tkt_main',
      kind: 'DUPLICATES_MERGED',
      actorType: 'STAFF',
      actorStaffId: 'plumbing@example.com',
      actorTeamId: 'PLUMBING',
      repairCycle: 1,
      note: 'Merged in #tkt_dup1, #tkt_dup2',
    });
    expect(all[1].Put?.Item).not.toHaveProperty('toPriority');
    expect(all[3].Put?.Item).toMatchObject({
      eventKey: `${NOW}#tkt_dup1_merged`,
      ticketId: 'tkt_dup1',
      kind: 'MERGED',
      actorType: 'STAFF',
      actorStaffId: 'plumbing@example.com',
      actorTeamId: 'PLUMBING',
      fromStatus: 'ASSIGNED',
      toStatus: 'MERGED',
      note: 'Merged into #tkt_main',
    });
    expect(all[5].Put?.Item).toMatchObject({
      ticketId: 'tkt_dup2',
      fromStatus: 'IN_PROGRESS',
    });
  });

  it('links the reporters of the sources to the canonical ticket without overwriting anyone', async () => {
    await mergeTickets(ticket(), [source1, source2], change);

    const [first, second] = items().slice(6);
    expect(first.Put).toEqual({
      TableName: 'TestReporters',
      Item: {
        ticketId: 'tkt_main',
        reporterLineUserId: 'Ubbb',
        associatedAt: NOW,
        associatedKey: `${NOW}#tkt_main`,
        sourceTicketId: 'tkt_dup1',
      },
      ConditionExpression: 'attribute_not_exists(reporterLineUserId)',
    });
    expect(second.Put?.Item).toMatchObject({
      reporterLineUserId: 'Uccc',
      sourceTicketId: 'tkt_dup2',
    });
  });

  it('never touches the sources reporters, photos or events already stored', async () => {
    await mergeTickets(ticket(), [source1], { ...change, reporters: [] });

    const tables = items().map((i) => (i.Update ?? i.Put)?.TableName);
    expect(tables).toEqual([
      'TestTickets',
      'TestEvents',
      'TestTickets',
      'TestEvents',
    ]);
  });

  it('refuses a merge without a source', async () => {
    await expect(mergeTickets(ticket(), [], change)).rejects.toThrow(
      'needs a source',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a merge that does not fit in one transaction', async () => {
    const reporters = Array.from(
      { length: MAX_TRANSACTION_ITEMS - mergeItemCount(1, 0) + 1 },
      (_, i) => ({ lineUserId: `U${i}`, sourceTicketId: 'tkt_dup1' }),
    );

    await expect(
      mergeTickets(ticket(), [source1], { ...change, reporters }),
    ).rejects.toThrow('does not fit');
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts a merge that exactly fills the transaction', async () => {
    const reporters = Array.from(
      { length: MAX_TRANSACTION_ITEMS - mergeItemCount(1, 0) },
      (_, i) => ({ lineUserId: `U${i}`, sourceTicketId: 'tkt_dup1' }),
    );

    await mergeTickets(ticket(), [source1], { ...change, reporters });

    expect(items()).toHaveLength(MAX_TRANSACTION_ITEMS);
  });

  it('passes on a cancelled transaction', async () => {
    const cancelled = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    send.mockRejectedValue(cancelled);

    await expect(mergeTickets(ticket(), [source1], change)).rejects.toBe(
      cancelled,
    );
  });
});

describe('mergeItemCount', () => {
  it('counts the canonical update and event, two per source and one per reporter', () => {
    expect(mergeItemCount(1, 0)).toBe(4);
    expect(mergeItemCount(10, 20)).toBe(42);
  });
});
