import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  ESCALATION_RESOLUTION_BREACH,
  listBreachedTickets,
  markSlaBreached,
} from '../../backend/src/shared/ticket-repository.js';
import { TEAM_IDS } from '../../backend/src/triage/policy.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date('2026-11-11T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();

interface QueryLike {
  input: {
    ExpressionAttributeValues: Record<string, unknown>;
    ExclusiveStartKey?: unknown;
  };
}

function item(id: string, team: string, deadlineAt: string) {
  return {
    ticketId: id,
    createdMonth: '2026-11',
    createdKey: `2026-11-10T08:00:00.000Z#${id}`,
    teamStatusKey: `TEAM#${team}#STATUS#ASSIGNED`,
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    version: 3,
    reporterLineUserId: 'Uabc',
    teamId: team,
    priority: 'MEDIUM',
    deadlineAt,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:05:00.000Z',
  };
}

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 2,
    photos: [],
    version: 3,
    reporterLineUserId: 'Uabc',
    teamId: 'PLUMBING',
    priority: 'MEDIUM',
    deadlineAt: '2026-11-11T09:00:00.000Z',
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_EVENTS_TABLE_NAME', 'TestEvents');
});
afterEach(() => vi.unstubAllEnvs());

describe('listBreachedTickets', () => {
  it('asks every team and both open statuses for tickets past their deadline that were not escalated', async () => {
    send.mockResolvedValue({ Items: [] });

    await expect(listBreachedTickets(NOW)).resolves.toEqual([]);

    const inputs = send.mock.calls.map((c) => c[0].input);
    expect(inputs).toHaveLength(TEAM_IDS.length * 2);
    expect(
      inputs.map((i) => i.ExpressionAttributeValues[':key']).sort(),
    ).toEqual(
      TEAM_IDS.flatMap((t) => [
        `TEAM#${t}#STATUS#ASSIGNED`,
        `TEAM#${t}#STATUS#IN_PROGRESS`,
      ]).sort(),
    );
    for (const input of inputs) {
      expect(input).toMatchObject({
        TableName: 'TestTickets',
        IndexName: 'TeamOpenIndex',
        KeyConditionExpression: 'teamStatusKey = :key',
        FilterExpression:
          'deadlineAt <= :now AND (attribute_not_exists(escalationLevel) OR escalationLevel < :level)',
      });
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':now': NOW_ISO,
        ':level': 2,
      });
    }
  });

  it('follows the pages of a partition and returns the oldest deadline first, without internal index keys', async () => {
    send.mockImplementation(async (command: QueryLike) => {
      const { ':key': key } = command.input.ExpressionAttributeValues;
      if (key === 'TEAM#PLUMBING#STATUS#ASSIGNED') {
        return command.input.ExclusiveStartKey
          ? { Items: [item('tkt_old', 'PLUMBING', '2026-11-11T05:00:00.000Z')] }
          : {
              Items: [item('tkt_mid', 'PLUMBING', '2026-11-11T08:00:00.000Z')],
              LastEvaluatedKey: { ticketId: 'tkt_mid' },
            };
      }
      if (key === 'TEAM#HVAC#STATUS#IN_PROGRESS') {
        return { Items: [item('tkt_new', 'HVAC', '2026-11-11T09:30:00.000Z')] };
      }
      return { Items: [] };
    });

    const tickets = await listBreachedTickets(NOW);

    expect(tickets.map((t) => t.id)).toEqual(['tkt_old', 'tkt_mid', 'tkt_new']);
    expect(tickets[0]).toMatchObject({
      id: 'tkt_old',
      teamId: 'PLUMBING',
      repairCycle: 1,
      photos: [],
    });
    expect(tickets[0]).not.toHaveProperty('createdKey');
    expect(tickets[0]).not.toHaveProperty('teamStatusKey');
    const pageTwo = send.mock.calls
      .map((c) => c[0].input)
      .find((i) => i.ExclusiveStartKey);
    expect(pageTwo.ExclusiveStartKey).toEqual({ ticketId: 'tkt_mid' });
  });
});

describe('markSlaBreached', () => {
  it('raises the level and writes an SLA_BREACHED event in one transaction', async () => {
    send.mockResolvedValue({});

    await expect(markSlaBreached(ticket(), NOW)).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const [update, put] = send.mock.calls[0][0].input.TransactItems;
    expect(update.Update).toEqual({
      TableName: 'TestTickets',
      Key: { ticketId: 'tkt_1' },
      ConditionExpression:
        '#status IN (:assigned, :inProgress) AND deadlineAt <= :now AND (attribute_not_exists(escalationLevel) OR escalationLevel < :level)',
      UpdateExpression: 'SET escalationLevel = :level',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':assigned': 'ASSIGNED',
        ':inProgress': 'IN_PROGRESS',
        ':now': NOW_ISO,
        ':level': ESCALATION_RESOLUTION_BREACH,
      },
    });
    expect(ESCALATION_RESOLUTION_BREACH).toBe(2);
    expect(put.Put.TableName).toBe('TestEvents');
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_breached_c2',
      ticketId: 'tkt_1',
      kind: 'SLA_BREACHED',
      occurredAt: NOW_ISO,
      actorType: 'SYSTEM',
      repairCycle: 2,
      note: 'The resolution deadline passed.',
      eventKey: `${NOW_ISO}#tkt_1_sla_breached_c2`,
    });
  });

  it('does not touch the ticket version, so nobody working on it is refused', async () => {
    send.mockResolvedValue({});
    await markSlaBreached(ticket(), NOW);
    const [update] = send.mock.calls[0][0].input.TransactItems;
    expect(update.Update.UpdateExpression).not.toContain('version');
    expect(update.Update.ConditionExpression).not.toContain('version');
  });

  it('gives a breach of a reopened cycle its own event id', async () => {
    send.mockResolvedValue({});
    await markSlaBreached(ticket({ repairCycle: 1 }), NOW);
    await markSlaBreached(ticket({ repairCycle: 2 }), NOW);
    const ids = send.mock.calls.map(
      (c) => c[0].input.TransactItems[1].Put.Item.id,
    );
    expect(ids).toEqual(['tkt_1_sla_breached_c1', 'tkt_1_sla_breached_c2']);
  });

  it('answers false when the ticket changed or the breach was already recorded', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
    );
    await expect(markSlaBreached(ticket(), NOW)).resolves.toBe(false);
  });

  it('passes on any other error', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(markSlaBreached(ticket(), NOW)).rejects.toThrow('throttled');
    send.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ValidationError' }, {}],
      }),
    );
    await expect(markSlaBreached(ticket(), NOW)).rejects.toThrow('cancelled');
    send.mockRejectedValueOnce(
      Object.assign(new Error('odd'), {
        name: 'Other',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(markSlaBreached(ticket(), NOW)).rejects.toThrow('odd');
  });
});
