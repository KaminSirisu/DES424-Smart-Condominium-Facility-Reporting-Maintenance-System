import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { reassignTicket } from '../../backend/src/shared/ticket-repository.js';
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

function assigned(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'The air conditioner drips.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 3,
    reporterLineUserId: 'Uabc123',
    teamId: 'PLUMBING',
    category: 'PLUMBING',
    priority: 'MEDIUM',
    deadlineAt: '2026-11-05T20:00:00.000Z',
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

describe('reassignTicket', () => {
  it('moves the ticket to the other team queue and records REASSIGNED, in one transaction', async () => {
    await reassignTicket(assigned(), {
      toTeamId: 'HVAC',
      accountId: 'manager@example.com',
      now: NOW,
      reason: 'The AI read the leak as a pipe, it is the air conditioner',
      deadlineAt: '2026-11-05T22:00:00.000Z',
    });

    expect(send).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(2);
    const [update, event] = items();

    expect(update.Update?.TableName).toBe('TestTickets');
    expect(update.Update?.Key).toEqual({ ticketId: 'tkt_1' });
    expect(update.Update?.UpdateExpression).toBe(
      'SET teamId = :team, teamStatusKey = :teamStatusKey, updatedAt = :now, ' +
        '#version = #version + :one, deadlineAt = :deadlineAt',
    );
    expect(update.Update?.ExpressionAttributeValues).toEqual({
      ':assigned': 'ASSIGNED',
      ':version': 3,
      ':one': 1,
      ':now': NOW,
      ':team': 'HVAC',
      ':teamStatusKey': 'TEAM#HVAC#STATUS#ASSIGNED',
      ':deadlineAt': '2026-11-05T22:00:00.000Z',
    });

    expect(event.Put?.TableName).toBe('TestEvents');
    expect(event.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: `${NOW}#tkt_1_reassigned_v4`,
      id: 'tkt_1_reassigned_v4',
      kind: 'REASSIGNED',
      occurredAt: NOW,
      actorType: 'STAFF',
      actorStaffId: 'manager@example.com',
      fromTeamId: 'PLUMBING',
      toTeamId: 'HVAC',
      repairCycle: 1,
      note: 'The AI read the leak as a pipe, it is the air conditioner',
    });
    // the manager has no team, so the event names none
    expect(event.Put?.Item).not.toHaveProperty('actorTeamId');
  });

  it('only succeeds for an ASSIGNED ticket at the version that was read', async () => {
    await reassignTicket(assigned(), {
      toTeamId: 'HVAC',
      accountId: 'm',
      now: NOW,
      reason: 'x',
    });

    const [update] = items();
    expect(update.Update?.ConditionExpression).toBe(
      '#status = :assigned AND #version = :version',
    );
    expect(update.Update?.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#version': 'version',
    });
  });

  it('leaves the deadline out when it does not change, and keeps the category', async () => {
    await reassignTicket(assigned(), {
      toTeamId: 'HVAC',
      accountId: 'm',
      now: NOW,
      reason: 'x',
    });

    const [update] = items();
    expect(update.Update?.UpdateExpression).not.toContain('deadlineAt');
    expect(update.Update?.UpdateExpression).not.toContain('category');
    expect(update.Update?.ExpressionAttributeValues).not.toHaveProperty(
      ':deadlineAt',
    );
  });

  it('gives a new event id for every version, so a second move is a new event', async () => {
    await reassignTicket(assigned({ version: 9 }), {
      toTeamId: 'ELECTRICAL',
      accountId: 'm',
      now: NOW,
      reason: 'x',
    });
    expect(items()[1].Put?.Item?.id).toBe('tkt_1_reassigned_v10');
  });

  it('puts the ticket update first, so a failed condition is reported at index 0', async () => {
    await reassignTicket(assigned(), {
      toTeamId: 'HVAC',
      accountId: 'm',
      now: NOW,
      reason: 'x',
    });
    expect(items()[0].Update).toBeDefined();
    expect(items()[1].Put).toBeDefined();
  });

  it('refuses a ticket without a team before touching the database', async () => {
    await expect(
      reassignTicket(assigned({ teamId: undefined }), {
        toTeamId: 'HVAC',
        accountId: 'm',
        now: NOW,
        reason: 'x',
      }),
    ).rejects.toThrow('has no team');
    expect(send).not.toHaveBeenCalled();
  });
});
