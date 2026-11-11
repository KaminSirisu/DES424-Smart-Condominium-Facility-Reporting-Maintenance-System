import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { listTicketEvents } from '../../backend/src/shared/ticket-repository.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, string | number>;

/** Event `n` of tkt_1, at 2026-11-05T0n:00. */
function event(n: number, overrides: Row = {}): Row {
  const occurredAt = `2026-11-05T0${n}:00:00.000Z`;
  return {
    ticketId: 'tkt_1',
    id: `tkt_1_e${n}`,
    eventKey: `${occurredAt}#tkt_1_e${n}`,
    kind: 'STATUS_CHANGED',
    occurredAt,
    actorType: 'STAFF',
    ...overrides,
  };
}

let stored: Row[] = [];

/** Query on the events table, as DynamoDB answers it. */
function fakeEvents() {
  send.mockImplementation(
    async (command: {
      input: {
        TableName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: Record<string, string>;
        Limit: number;
        ScanIndexForward: boolean;
        ConsistentRead: boolean;
      };
    }) => {
      const { input } = command;
      const v = input.ExpressionAttributeValues;
      const rows = stored
        .filter(
          (r) =>
            r.ticketId === v[':ticketId'] &&
            (!v[':after'] || String(r.eventKey) > v[':after']),
        )
        .sort((a, b) => String(a.eventKey).localeCompare(String(b.eventKey)));
      if (input.ScanIndexForward === false) rows.reverse();
      return { Items: rows.slice(0, input.Limit) };
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKET_EVENTS_TABLE_NAME', 'TestEvents');
  stored = [];
  fakeEvents();
});
afterEach(() => vi.unstubAllEnvs());

describe('listTicketEvents', () => {
  it('returns the events oldest first, without the storage key, read with strong consistency', async () => {
    stored = [event(3), event(1), event(2)];

    const page = await listTicketEvents('tkt_1', { limit: 10 });

    expect(page.events.map((e) => e.id)).toEqual([
      'tkt_1_e1',
      'tkt_1_e2',
      'tkt_1_e3',
    ]);
    expect(page.events[0]).not.toHaveProperty('eventKey');
    expect(page.events[0]).toMatchObject({
      ticketId: 'tkt_1',
      kind: 'STATUS_CHANGED',
      actorType: 'STAFF',
    });
    expect(page.next).toBeUndefined();
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: 'TestEvents',
      KeyConditionExpression: 'ticketId = :ticketId',
      ConsistentRead: true,
      ScanIndexForward: true,
    });
  });

  it('pages through every event once, and the last page has no cursor', async () => {
    stored = [1, 2, 3, 4, 5].map((n) => event(n));

    const seen: string[] = [];
    let after: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await listTicketEvents('tkt_1', { limit: 2, after });
      seen.push(...page.events.map((e) => e.id));
      sizes.push(page.events.length);
      after = page.next;
    } while (after);

    expect(seen).toEqual([
      'tkt_1_e1',
      'tkt_1_e2',
      'tkt_1_e3',
      'tkt_1_e4',
      'tkt_1_e5',
    ]);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('has no next page when the events exactly fill the limit', async () => {
    stored = [event(1), event(2)];
    const page = await listTicketEvents('tkt_1', { limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.next).toBeUndefined();
  });

  it('reads one more than the limit, to know there is more', async () => {
    stored = [event(1), event(2), event(3)];
    await listTicketEvents('tkt_1', { limit: 2 });
    expect(send.mock.calls[0][0].input.Limit).toBe(3);
  });

  it('continues after the given key', async () => {
    stored = [event(1), event(2), event(3)];

    const page = await listTicketEvents('tkt_1', {
      limit: 10,
      after: '2026-11-05T01:00:00.000Z#tkt_1_e1',
    });

    expect(page.events.map((e) => e.id)).toEqual(['tkt_1_e2', 'tkt_1_e3']);
    expect(send.mock.calls[0][0].input.KeyConditionExpression).toBe(
      'ticketId = :ticketId AND eventKey > :after',
    );
  });

  it('reads only the events of this ticket', async () => {
    stored = [event(1), event(2, { ticketId: 'tkt_2', id: 'tkt_2_e2' })];
    const page = await listTicketEvents('tkt_1', { limit: 10 });
    expect(page.events.map((e) => e.id)).toEqual(['tkt_1_e1']);
  });

  it('returns an empty page for a ticket with no events', async () => {
    await expect(listTicketEvents('tkt_1', { limit: 10 })).resolves.toEqual({
      events: [],
    });
  });

  it('fails clearly when the table name is not set', async () => {
    vi.stubEnv('TICKET_EVENTS_TABLE_NAME', '');
    await expect(listTicketEvents('tkt_1', { limit: 10 })).rejects.toThrow(
      'TICKET_EVENTS_TABLE_NAME environment variable is not set.',
    );
  });
});
