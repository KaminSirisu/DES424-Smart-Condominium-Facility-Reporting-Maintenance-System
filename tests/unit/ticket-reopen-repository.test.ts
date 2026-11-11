import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { reopenTicket } from '../../backend/src/shared/ticket-repository.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const NOW = '2026-11-07T10:00:00.000Z';

interface SentItem {
  TableName: string;
  Key?: Record<string, unknown>;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function items(): { Update?: SentItem; Put?: SentItem }[] {
  return send.mock.calls[0][0].input.TransactItems;
}

function done(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'DONE',
    repairCycle: 1,
    photos: [],
    version: 6,
    reporterLineUserId: 'Uabc123',
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    deadlineAt: '2026-11-05T20:00:00.000Z',
    completedAt: '2026-11-05T15:00:00.000Z',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T15:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_EVENTS_TABLE_NAME', 'TestEvents');
  send.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe('reopenTicket', () => {
  it('sends the ticket back to the team, starts a new SLA clock and records REOPENED, in one transaction', async () => {
    await reopenTicket(done(), {
      now: NOW,
      reopenKey: 'hash-of-the-key',
      reason: 'The faucet leaks again',
      deadlineAt: '2026-11-07T22:00:00.000Z',
    });

    expect(send).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(2);
    const [update, event] = items();

    expect(update.Update?.TableName).toBe('TestTickets');
    expect(update.Update?.Key).toEqual({ ticketId: 'tkt_1' });
    expect(update.Update?.UpdateExpression).toBe(
      'SET #status = :assigned, repairCycle = :cycle, updatedAt = :now, ' +
        '#version = #version + :one, teamStatusKey = :teamStatusKey, ' +
        'slaStartAt = :now, reopenKey = :reopenKey, deadlineAt = :deadlineAt ' +
        'REMOVE completedAt, teamDoneKey, completedKey, escalationLevel',
    );
    expect(update.Update?.ExpressionAttributeValues).toEqual({
      ':done': 'DONE',
      ':assigned': 'ASSIGNED',
      ':version': 6,
      ':one': 1,
      ':now': NOW,
      ':cycle': 2,
      ':teamStatusKey': 'TEAM#PLUMBING#STATUS#ASSIGNED',
      ':reopenKey': 'hash-of-the-key',
      ':deadlineAt': '2026-11-07T22:00:00.000Z',
    });

    expect(event.Put?.TableName).toBe('TestEvents');
    expect(event.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: `${NOW}#tkt_1_reopened_v7`,
      id: 'tkt_1_reopened_v7',
      kind: 'REOPENED',
      occurredAt: NOW,
      actorType: 'REPORTER',
      fromStatus: 'DONE',
      toStatus: 'ASSIGNED',
      repairCycle: 2,
      note: 'The faucet leaks again',
    });
  });

  it('only succeeds for a DONE ticket at the version that was read', async () => {
    await reopenTicket(done(), { now: NOW, reopenKey: 'k' });

    const [update] = items();
    expect(update.Update?.ConditionExpression).toBe(
      '#status = :done AND #version = :version',
    );
    expect(update.Update?.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#version': 'version',
    });
  });

  it('puts the ticket update first, so a failed condition is reported at index 0', async () => {
    await reopenTicket(done(), { now: NOW, reopenKey: 'k' });
    expect(items()[0].Update).toBeDefined();
    expect(items()[1].Put).toBeDefined();
  });

  it('leaves the deadline and the note out when there are none', async () => {
    await reopenTicket(done(), { now: NOW, reopenKey: 'k' });

    const [update, event] = items();
    expect(update.Update?.UpdateExpression).not.toContain('deadlineAt');
    expect(update.Update?.ExpressionAttributeValues).not.toHaveProperty(
      ':deadlineAt',
    );
    expect(event.Put?.Item).not.toHaveProperty('note');
  });

  it('counts the next cycle from the current one and gives every reopen its own event', async () => {
    await reopenTicket(done({ repairCycle: 3, version: 11 }), {
      now: NOW,
      reopenKey: 'k',
    });

    const [update, event] = items();
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':cycle': 4,
    });
    expect(event.Put?.Item).toMatchObject({
      id: 'tkt_1_reopened_v12',
      repairCycle: 4,
    });
  });

  it('puts the ticket back in the queue of its own team', async () => {
    await reopenTicket(done({ teamId: 'HVAC' }), { now: NOW, reopenKey: 'k' });
    expect(items()[0].Update?.ExpressionAttributeValues).toMatchObject({
      ':teamStatusKey': 'TEAM#HVAC#STATUS#ASSIGNED',
    });
  });

  it('refuses a ticket without a team before touching the database', async () => {
    await expect(
      reopenTicket(done({ teamId: undefined }), { now: NOW, reopenKey: 'k' }),
    ).rejects.toThrow('has no team');
    expect(send).not.toHaveBeenCalled();
  });
});
