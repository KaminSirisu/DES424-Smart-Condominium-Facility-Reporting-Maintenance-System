import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { setTicketPriority } from '../../backend/src/shared/ticket-repository.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const NOW = '2026-11-05T09:00:00.000Z';

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

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 3,
    reporterLineUserId: 'Uabc123',
    teamId: 'PLUMBING',
    priority: 'LOW',
    prioritySetBy: 'AI',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
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

describe('setTicketPriority', () => {
  it('changes the priority and the deadline and records PRIORITY_CHANGED, in one transaction', async () => {
    await setTicketPriority(ticket(), {
      to: 'CRITICAL',
      accountId: 'plumbing@example.com',
      teamId: 'PLUMBING',
      now: NOW,
      reason: 'Water near the lift motor',
      deadlineAt: '2026-11-05T11:00:00.000Z',
    });

    expect(send).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(2);
    const [update, event] = items();

    expect(update.Update?.TableName).toBe('TestTickets');
    expect(update.Update?.Key).toEqual({ ticketId: 'tkt_1' });
    expect(update.Update?.UpdateExpression).toBe(
      'SET priority = :priority, prioritySetBy = :staff, updatedAt = :now, #version = #version + :one, deadlineAt = :deadlineAt',
    );
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':priority': 'CRITICAL',
      ':staff': 'STAFF',
      ':now': NOW,
      ':deadlineAt': '2026-11-05T11:00:00.000Z',
      ':version': 3,
    });

    expect(event.Put?.TableName).toBe('TestEvents');
    expect(event.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: `${NOW}#tkt_1_priority_v4`,
      id: 'tkt_1_priority_v4',
      kind: 'PRIORITY_CHANGED',
      occurredAt: NOW,
      actorType: 'STAFF',
      actorStaffId: 'plumbing@example.com',
      actorTeamId: 'PLUMBING',
      fromPriority: 'LOW',
      toPriority: 'CRITICAL',
      repairCycle: 1,
      note: 'Water near the lift motor',
    });
  });

  it('only succeeds for an open ticket at the version that was read', async () => {
    await setTicketPriority(ticket(), {
      to: 'MEDIUM',
      accountId: 'plumbing@example.com',
      now: NOW,
    });

    const [update] = items();
    expect(update.Update?.ConditionExpression).toBe(
      '#status IN (:assigned, :inProgress) AND #version = :version',
    );
    expect(update.Update?.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#version': 'version',
    });
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':assigned': 'ASSIGNED',
      ':inProgress': 'IN_PROGRESS',
    });
  });

  it('records PRIORITY_CONFIRMED when the same priority is accepted, without a deadline or a note', async () => {
    await setTicketPriority(ticket(), {
      to: 'LOW',
      accountId: 'plumbing@example.com',
      teamId: 'PLUMBING',
      now: NOW,
    });

    const [update, event] = items();
    expect(update.Update?.UpdateExpression).toBe(
      'SET priority = :priority, prioritySetBy = :staff, updatedAt = :now, #version = #version + :one',
    );
    expect(update.Update?.ExpressionAttributeValues).not.toHaveProperty(
      ':deadlineAt',
    );
    expect(event.Put?.Item).toMatchObject({
      kind: 'PRIORITY_CONFIRMED',
      fromPriority: 'LOW',
      toPriority: 'LOW',
    });
    expect(event.Put?.Item).not.toHaveProperty('note');
  });

  it('records no team for a manager and no fromPriority when there was none', async () => {
    await setTicketPriority(ticket({ priority: undefined }), {
      to: 'MEDIUM',
      accountId: 'manager@example.com',
      now: NOW,
      reason: 'Set by hand',
    });

    const [, event] = items();
    expect(event.Put?.Item).not.toHaveProperty('actorTeamId');
    expect(event.Put?.Item).not.toHaveProperty('fromPriority');
    expect(event.Put?.Item).toMatchObject({
      kind: 'PRIORITY_CHANGED',
      actorStaffId: 'manager@example.com',
    });
  });

  it('gives a new event id for every version, so a second change is a new event', async () => {
    await setTicketPriority(ticket({ version: 7 }), {
      to: 'MEDIUM',
      accountId: 'plumbing@example.com',
      now: NOW,
      reason: 'x',
    });
    expect(items()[1].Put?.Item?.id).toBe('tkt_1_priority_v8');
  });

  it('puts the ticket update first, so a failed condition is reported at index 0', async () => {
    await setTicketPriority(ticket(), {
      to: 'MEDIUM',
      accountId: 'a',
      now: NOW,
      reason: 'x',
    });
    expect(items()[0].Update).toBeDefined();
    expect(items()[1].Put).toBeDefined();
  });
});
