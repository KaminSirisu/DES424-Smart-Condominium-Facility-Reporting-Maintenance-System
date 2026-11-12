import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  listOpenTickets,
  recordSlaAlert,
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

describe('listOpenTickets', () => {
  it('asks every team and both open statuses, without a filter', async () => {
    send.mockResolvedValue({ Items: [] });

    await expect(listOpenTickets()).resolves.toEqual([]);

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
      });
      expect(input).not.toHaveProperty('FilterExpression');
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

    const tickets = await listOpenTickets();

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

describe('recordSlaAlert', () => {
  const OPEN_VALUES = { ':assigned': 'ASSIGNED', ':inProgress': 'IN_PROGRESS' };
  const sent = () => send.mock.calls[0][0].input.TransactItems;

  it('records a ticket that waited too long for triage: a mark and an SLA_TRIAGE_DELAYED event, only while it is still RECEIVED', async () => {
    send.mockResolvedValue({});

    await expect(
      recordSlaAlert(
        ticket({ status: 'RECEIVED', teamId: undefined }),
        { kind: 'TRIAGE_DELAYED' },
        NOW,
      ),
    ).resolves.toBe(true);

    const [update, put] = sent();
    expect(update.Update).toEqual({
      TableName: 'TestTickets',
      Key: { ticketId: 'tkt_1' },
      ConditionExpression:
        '#status = :received AND attribute_not_exists(slaTriageDelayedAt)',
      UpdateExpression: 'SET slaTriageDelayedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':received': 'RECEIVED', ':now': NOW_ISO },
    });
    expect(put.Put.TableName).toBe('TestEvents');
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_triage_delayed',
      ticketId: 'tkt_1',
      kind: 'SLA_TRIAGE_DELAYED',
      occurredAt: NOW_ISO,
      actorType: 'SYSTEM',
      note: 'The ticket was not triaged within the triage delay.',
      eventKey: `${NOW_ISO}#tkt_1_sla_triage_delayed`,
    });
    expect(update.Update.UpdateExpression).not.toContain('version');
  });

  it('records the warning (E0): a mark and an SLA_WARNING event, one transaction', async () => {
    send.mockResolvedValue({});

    await expect(
      recordSlaAlert(ticket(), { kind: 'WARNING' }, NOW),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const [update, put] = sent();
    expect(update.Update).toEqual({
      TableName: 'TestTickets',
      Key: { ticketId: 'tkt_1' },
      ConditionExpression:
        '#status IN (:assigned, :inProgress) AND attribute_not_exists(slaWarnedAt) AND deadlineAt = :deadline AND deadlineAt > :now',
      UpdateExpression: 'SET slaWarnedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ...OPEN_VALUES,
        ':deadline': '2026-11-11T09:00:00.000Z',
        ':now': NOW_ISO,
      },
    });
    expect(put.Put.TableName).toBe('TestEvents');
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_warning_c2',
      ticketId: 'tkt_1',
      kind: 'SLA_WARNING',
      occurredAt: NOW_ISO,
      actorType: 'SYSTEM',
      repairCycle: 2,
      note: 'Seventy-five percent of the resolution time has passed.',
      eventKey: `${NOW_ISO}#tkt_1_sla_warning_c2`,
    });
  });

  it('records the missed response target (E1) only for a ticket that is still ASSIGNED and has the same priority', async () => {
    send.mockResolvedValue({});

    await recordSlaAlert(ticket(), { kind: 'RESPONSE_BREACH' }, NOW);

    const [update, put] = sent();
    expect(update.Update).toMatchObject({
      ConditionExpression:
        '#status = :assigned AND attribute_not_exists(slaResponseBreachedAt) AND priority = :priority',
      UpdateExpression: 'SET slaResponseBreachedAt = :now',
      ExpressionAttributeValues: {
        ':assigned': 'ASSIGNED',
        ':priority': 'MEDIUM',
        ':now': NOW_ISO,
      },
    });
    expect(Object.keys(update.Update.ExpressionAttributeValues)).toHaveLength(
      3,
    );
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_response_c2',
      kind: 'SLA_RESPONSE_BREACHED',
      note: 'The response target passed while the ticket was still ASSIGNED.',
    });
  });

  it('records the first resolution breach (E2): the marks and an SLA_BREACHED event', async () => {
    send.mockResolvedValue({});

    await recordSlaAlert(ticket(), { kind: 'RESOLUTION_BREACH', sent: 0 }, NOW);

    const [update, put] = sent();
    expect(update.Update).toEqual({
      TableName: 'TestTickets',
      Key: { ticketId: 'tkt_1' },
      ConditionExpression:
        '#status IN (:assigned, :inProgress) AND deadlineAt <= :now AND attribute_not_exists(slaBreachedAt)',
      UpdateExpression:
        'SET slaBreachedAt = :now, slaBreachAlerts = :next, slaLastBreachAlertAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ...OPEN_VALUES,
        ':now': NOW_ISO,
        ':next': 1,
      },
    });
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_breached_c2_n1',
      kind: 'SLA_BREACHED',
      note: 'The resolution deadline passed.',
    });
  });

  it('records a reminder (E2) only for a CRITICAL ticket whose last alert is an hour old, and counts it', async () => {
    send.mockResolvedValue({});

    await recordSlaAlert(
      ticket({ priority: 'CRITICAL' }),
      { kind: 'RESOLUTION_BREACH', sent: 2 },
      NOW,
    );

    const [update, put] = sent();
    expect(update.Update).toMatchObject({
      ConditionExpression:
        '#status IN (:assigned, :inProgress) AND priority = :critical AND slaBreachAlerts = :sent AND slaLastBreachAlertAt <= :cutoff',
      UpdateExpression:
        'SET slaBreachAlerts = :next, slaLastBreachAlertAt = :now',
      ExpressionAttributeValues: {
        ...OPEN_VALUES,
        ':critical': 'CRITICAL',
        ':sent': 2,
        ':next': 3,
        ':now': NOW_ISO,
        ':cutoff': '2026-11-11T09:00:00.000Z',
      },
    });
    expect(put.Put.Item).toMatchObject({
      id: 'tkt_1_sla_breached_c2_n3',
      kind: 'SLA_BREACHED',
      note: 'The resolution deadline passed (reminder 2).',
    });
  });

  it('gives an alert of a reopened cycle its own event id', async () => {
    send.mockResolvedValue({});
    await recordSlaAlert(ticket({ repairCycle: 1 }), { kind: 'WARNING' }, NOW);
    await recordSlaAlert(ticket({ repairCycle: 2 }), { kind: 'WARNING' }, NOW);
    const ids = send.mock.calls.map(
      (c) => c[0].input.TransactItems[1].Put.Item.id,
    );
    expect(ids).toEqual(['tkt_1_sla_warning_c1', 'tkt_1_sla_warning_c2']);
  });

  it('does not touch the ticket version, so nobody working on it is refused', async () => {
    send.mockResolvedValue({});
    for (const alert of [
      { kind: 'WARNING' },
      { kind: 'RESPONSE_BREACH' },
      { kind: 'RESOLUTION_BREACH', sent: 0 },
      { kind: 'RESOLUTION_BREACH', sent: 1 },
    ] as const) {
      send.mockClear();
      await recordSlaAlert(ticket({ priority: 'CRITICAL' }), alert, NOW);
      const [update] = send.mock.calls[0][0].input.TransactItems;
      expect(update.Update.UpdateExpression).not.toContain('version');
      expect(update.Update.ConditionExpression).not.toContain('version');
    }
  });

  it('answers false when the ticket changed or the alert was already recorded', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
    );
    await expect(
      recordSlaAlert(ticket(), { kind: 'WARNING' }, NOW),
    ).resolves.toBe(false);
  });

  it('passes on any other error', async () => {
    const alert = { kind: 'WARNING' } as const;
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(recordSlaAlert(ticket(), alert, NOW)).rejects.toThrow(
      'throttled',
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ValidationError' }, {}],
      }),
    );
    await expect(recordSlaAlert(ticket(), alert, NOW)).rejects.toThrow(
      'cancelled',
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error('odd'), {
        name: 'Other',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(recordSlaAlert(ticket(), alert, NOW)).rejects.toThrow('odd');
  });
});
