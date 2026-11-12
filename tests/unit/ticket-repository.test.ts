import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  QuotaExceededError,
  applyTriage,
  createTicket,
  getTicket,
} from '../../backend/src/shared/ticket-repository.js';
import {
  ticketIpQuotaClaim,
  ticketQuotaClaim,
} from '../../backend/src/shared/rate-limit.js';
import type { TriageUpdate } from '../../backend/src/shared/ticket-repository.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const TABLES = {
  TICKETS_TABLE_NAME: 'TestTickets',
  TICKET_REPORTERS_TABLE_NAME: 'TestReporters',
  TICKET_PHOTOS_TABLE_NAME: 'TestPhotos',
  TICKET_EVENTS_TABLE_NAME: 'TestEvents',
  RATE_LIMITS_TABLE_NAME: 'TestRateLimits',
};

interface SentItem {
  TableName: string;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
  UpdateExpression?: string;
  Key?: Record<string, unknown>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/** The items of the transaction sent by the first call, as `{Put|Update}` bodies. */
function transactItems(): { Put?: SentItem; Update?: SentItem }[] {
  return send.mock.calls[0][0].input.TransactItems;
}

function record(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'RECEIVED',
    repairCycle: 1,
    photos: [
      {
        id: 'upl_1',
        purpose: 'DEFECT',
        addedAt: '2026-10-28T10:00:00.000Z',
        s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
      },
    ],
    version: 1,
    reporterLineUserId: 'Uabc123',
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const [name, value] of Object.entries(TABLES)) {
    vi.stubEnv(name, value);
  }
  send.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe('createTicket', () => {
  it('writes the ticket, reporter, photo and event to their own tables in one transaction', async () => {
    await createTicket(record());

    expect(send).toHaveBeenCalledOnce();
    const [ticket, reporter, photo, event] = transactItems();

    // The ticket comes first: its condition failing is how a duplicate is detected.
    expect(ticket.Put?.TableName).toBe('TestTickets');
    expect(ticket.Put?.ConditionExpression).toBe(
      'attribute_not_exists(ticketId)',
    );
    expect(ticket.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      status: 'RECEIVED',
      version: 1,
      reporterLineUserId: 'Uabc123',
      createdMonth: '2026-10',
      createdKey: '2026-10-28T10:00:00.000Z#tkt_1',
    });
    expect(ticket.Put?.Item).not.toHaveProperty('id');
    expect(ticket.Put?.Item).not.toHaveProperty('photos');
    expect(ticket.Put?.Item).not.toHaveProperty('teamStatusKey');

    expect(reporter.Put?.TableName).toBe('TestReporters');
    expect(reporter.Put?.Item).toEqual({
      ticketId: 'tkt_1',
      reporterLineUserId: 'Uabc123',
      associatedAt: '2026-10-28T10:00:00.000Z',
      associatedKey: '2026-10-28T10:00:00.000Z#tkt_1',
    });

    expect(photo.Put?.TableName).toBe('TestPhotos');
    expect(photo.Put?.Item).toEqual({
      ticketId: 'tkt_1',
      photoId: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-10-28T10:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
    });

    expect(event.Put?.TableName).toBe('TestEvents');
    expect(event.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: '2026-10-28T10:00:00.000Z#tkt_1_created',
      id: 'tkt_1_created',
      kind: 'CREATED',
      actorType: 'REPORTER',
      toStatus: 'RECEIVED',
      repairCycle: 1,
    });
  });

  it('writes one item per photo', async () => {
    await createTicket(
      record({
        photos: [
          ...record().photos,
          {
            id: 'upl_2',
            purpose: 'DEFECT',
            addedAt: '2026-10-28T10:00:00.000Z',
            s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_2',
          },
        ],
      }),
    );
    const photoIds = transactItems()
      .filter((i) => i.Put?.TableName === 'TestPhotos')
      .map((i) => i.Put?.Item?.photoId);
    expect(photoIds).toEqual(['upl_1', 'upl_2']);
  });

  describe('with a quota claim (SR-31)', () => {
    const claim = () =>
      ticketQuotaClaim('Uabc123', new Date('2026-10-28T10:30:00Z'));
    const cancelled = (codes: string[]) =>
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: codes.map((Code) => ({ Code })),
      });

    it('counts the creation in the same transaction, after everything else', async () => {
      await createTicket(record(), claim());

      expect(send).toHaveBeenCalledOnce();
      const items = transactItems();
      expect(items).toHaveLength(5);
      // the ticket is still first, so a duplicate is still reported at index 0
      expect(items[0].Put?.TableName).toBe('TestTickets');
      const last = items[4] as { Update?: SentItem };
      expect(last.Update?.TableName).toBe('TestRateLimits');
      expect(last.Update?.Key).toEqual({
        limitKey: 'TICKET_CREATE#Uabc123',
        windowStart: 1793181600,
      });
    });

    it('counts a list of claims, the reporter and the address, in that order', async () => {
      const ipClaim = ticketIpQuotaClaim(
        '203.0.113.7',
        new Date('2026-10-28T10:30:00Z'),
      );
      await createTicket(record(), [claim(), ipClaim]);

      const items = transactItems();
      expect(items).toHaveLength(6);
      expect((items[4] as { Update?: SentItem }).Update?.Key).toEqual({
        limitKey: 'TICKET_CREATE#Uabc123',
        windowStart: 1793181600,
      });
      expect((items[5] as { Update?: SentItem }).Update?.Key).toEqual({
        limitKey: 'TICKET_CREATE_IP#203.0.113.7',
        windowStart: 1793181600,
      });
    });

    it('writes no counter for an empty list', async () => {
      await createTicket(record(), []);
      expect(transactItems()).toHaveLength(4);
    });

    describe('when either of two counters refuses', () => {
      const earlier = () =>
        ticketQuotaClaim('Uabc123', new Date('2026-10-28T10:50:00Z')); // 600 s left
      const later = () =>
        ticketIpQuotaClaim('203.0.113.7', new Date('2026-10-28T10:10:00Z')); // 3000 s left

      it('says how long until the reporter counter resets when only it refuses', async () => {
        send.mockRejectedValue(
          cancelled([
            'None',
            'None',
            'None',
            'None',
            'ConditionalCheckFailed',
            'None',
          ]),
        );
        await expect(
          createTicket(record(), [earlier(), later()]),
        ).rejects.toMatchObject({
          name: 'QuotaExceededError',
          retryAfterSeconds: 600,
        });
      });

      it('says how long until the address counter resets when only it refuses', async () => {
        send.mockRejectedValue(
          cancelled([
            'None',
            'None',
            'None',
            'None',
            'None',
            'ConditionalCheckFailed',
          ]),
        );
        await expect(
          createTicket(record(), [earlier(), later()]),
        ).rejects.toMatchObject({
          name: 'QuotaExceededError',
          retryAfterSeconds: 3000,
        });
      });

      it('waits for the longer one when both refuse', async () => {
        send.mockRejectedValue(
          cancelled([
            'None',
            'None',
            'None',
            'None',
            'ConditionalCheckFailed',
            'ConditionalCheckFailed',
          ]),
        );
        await expect(
          createTicket(record(), [earlier(), later()]),
        ).rejects.toMatchObject({ retryAfterSeconds: 3000 });
      });

      it('rethrows the duplicate-ticket failure when the ticket already exists', async () => {
        const duplicate = cancelled([
          'ConditionalCheckFailed',
          'None',
          'None',
          'None',
          'ConditionalCheckFailed',
          'ConditionalCheckFailed',
        ]);
        send.mockRejectedValue(duplicate);
        await expect(createTicket(record(), [earlier(), later()])).rejects.toBe(
          duplicate,
        );
      });

      it('rethrows a failure that is not a refused counter', async () => {
        const other = cancelled([
          'None',
          'None',
          'None',
          'None',
          'None',
          'ThrottlingError',
        ]);
        send.mockRejectedValue(other);
        await expect(createTicket(record(), [earlier(), later()])).rejects.toBe(
          other,
        );
      });
    });

    it('writes no counter without a claim', async () => {
      await createTicket(record());
      expect(transactItems()).toHaveLength(4);
    });

    it('throws QuotaExceededError with the Retry-After when only the counter refuses', async () => {
      send.mockRejectedValue(
        cancelled(['None', 'None', 'None', 'None', 'ConditionalCheckFailed']),
      );

      await expect(createTicket(record(), claim())).rejects.toMatchObject({
        name: 'QuotaExceededError',
        retryAfterSeconds: 1800,
      });
      await expect(createTicket(record(), claim())).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });

    it('rethrows the duplicate-ticket failure when the ticket already exists, even if the counter also refuses', async () => {
      const duplicate = cancelled([
        'ConditionalCheckFailed',
        'None',
        'None',
        'None',
        'ConditionalCheckFailed',
      ]);
      send.mockRejectedValue(duplicate);

      await expect(createTicket(record(), claim())).rejects.toBe(duplicate);
    });

    it('rethrows any other failure, and a refusal when no claim was made', async () => {
      const other = cancelled([
        'None',
        'None',
        'None',
        'None',
        'ThrottlingError',
      ]);
      send.mockRejectedValue(other);
      await expect(createTicket(record(), claim())).rejects.toBe(other);

      const refused = cancelled([
        'None',
        'None',
        'None',
        'ConditionalCheckFailed',
      ]);
      send.mockRejectedValue(refused);
      await expect(createTicket(record())).rejects.toBe(refused);

      const plain = new Error('network');
      send.mockRejectedValue(plain);
      await expect(createTicket(record(), claim())).rejects.toBe(plain);
    });
  });

  it('fails clearly when a table name is not configured', async () => {
    vi.stubEnv('TICKET_PHOTOS_TABLE_NAME', '');
    await expect(createTicket(record())).rejects.toThrow(
      'TICKET_PHOTOS_TABLE_NAME environment variable is not set.',
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('getTicket', () => {
  function stubReads(
    ticketItem: Record<string, unknown> | undefined,
    photoPages: {
      Items: Record<string, unknown>[];
      LastEvaluatedKey?: object;
    }[],
  ): void {
    const pages = [...photoPages];
    send.mockImplementation(async (command: { input: SentItem }) => {
      if (command.input.TableName === 'TestTickets') {
        return { Item: ticketItem };
      }
      return pages.shift() ?? { Items: [] };
    });
  }

  const storedTicket = {
    ticketId: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'RECEIVED',
    repairCycle: 1,
    version: 1,
    reporterLineUserId: 'Uabc123',
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    createdMonth: '2026-10',
    createdKey: '2026-10-28T10:00:00.000Z#tkt_1',
    teamStatusKey: 'TEAM#PLUMBING#STATUS#ASSIGNED',
  };
  const storedPhoto = {
    ticketId: 'tkt_1',
    photoId: 'upl_1',
    purpose: 'DEFECT',
    addedAt: '2026-10-28T10:00:00.000Z',
    s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
  };

  it('assembles the ticket record with its photos and no storage attributes', async () => {
    stubReads(storedTicket, [{ Items: [storedPhoto] }]);

    const ticket = await getTicket('tkt_1');

    expect(ticket).toEqual(record());
    expect(ticket).not.toHaveProperty('ticketId');
    expect(ticket).not.toHaveProperty('createdMonth');
    expect(ticket).not.toHaveProperty('createdKey');
    expect(ticket).not.toHaveProperty('teamStatusKey');
  });

  it('reads both tables with strong consistency', async () => {
    stubReads(storedTicket, [{ Items: [storedPhoto] }]);
    await getTicket('tkt_1');

    const inputs = send.mock.calls.map((call) => call[0].input);
    const get = inputs.find((i) => i.TableName === 'TestTickets');
    const query = inputs.find((i) => i.TableName === 'TestPhotos');
    expect(get).toMatchObject({
      Key: { ticketId: 'tkt_1' },
      ConsistentRead: true,
    });
    expect(query).toMatchObject({
      KeyConditionExpression: 'ticketId = :ticketId',
      ExpressionAttributeValues: { ':ticketId': 'tkt_1' },
      ConsistentRead: true,
    });
  });

  it('returns null for an unknown ticket', async () => {
    stubReads(undefined, [{ Items: [] }]);
    await expect(getTicket('tkt_x')).resolves.toBeNull();
  });

  it('follows the photo query across pages', async () => {
    stubReads(storedTicket, [
      { Items: [storedPhoto], LastEvaluatedKey: { ticketId: 'tkt_1' } },
      { Items: [{ ...storedPhoto, photoId: 'upl_2' }] },
    ]);
    const ticket = await getTicket('tkt_1');
    expect(ticket?.photos.map((p) => p.id)).toEqual(['upl_1', 'upl_2']);
  });

  it('keeps repairCycle on a repair proof photo', async () => {
    stubReads(storedTicket, [
      {
        Items: [
          {
            ...storedPhoto,
            photoId: 'upl_9',
            purpose: 'REPAIR_PROOF',
            repairCycle: 2,
          },
        ],
      },
    ]);
    const ticket = await getTicket('tkt_1');
    expect(ticket?.photos[0]).toMatchObject({
      id: 'upl_9',
      purpose: 'REPAIR_PROOF',
      repairCycle: 2,
    });
  });
});

describe('applyTriage', () => {
  const update: TriageUpdate = {
    category: 'PLUMBING',
    priority: 'MEDIUM',
    teamId: 'PLUMBING',
    deadlineAt: '2026-10-29T10:00:00.000Z',
    slaPolicyVersion: 1,
    now: '2026-10-28T10:30:00.000Z',
  };

  it('updates the ticket and writes a TRIAGED event in one transaction', async () => {
    await applyTriage('tkt_1', 3, update);

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update?.TableName).toBe('TestTickets');
    expect(ticketUpdate.Update?.Key).toEqual({ ticketId: 'tkt_1' });
    expect(ticketUpdate.Update?.ConditionExpression).toBe(
      '#status = :received AND #version = :version',
    );
    expect(ticketUpdate.Update?.ExpressionAttributeValues).toMatchObject({
      ':version': 3,
      ':priority': 'MEDIUM',
      ':teamStatusKey': 'TEAM#PLUMBING#STATUS#ASSIGNED',
      ':prioritySetBy': 'AI',
    });
    expect(ticketUpdate.Update?.UpdateExpression).toContain(
      'prioritySetBy = :prioritySetBy',
    );
    // The matrix result is not kept next to the priority any more.
    expect(ticketUpdate.Update?.UpdateExpression).not.toContain('suggested');
    expect(
      JSON.stringify(ticketUpdate.Update?.ExpressionAttributeValues),
    ).not.toContain(':suggested');
    expect(eventPut.Put?.TableName).toBe('TestEvents');
    expect(eventPut.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: '2026-10-28T10:30:00.000Z#tkt_1_triaged',
      kind: 'TRIAGED',
      toPriority: 'MEDIUM',
    });
  });

  it('records the automatic triage as the system, with no manager', async () => {
    await applyTriage('tkt_1', 3, update);

    const [ticketUpdate, eventPut] = transactItems();
    expect(eventPut.Put?.Item).toMatchObject({ actorType: 'SYSTEM' });
    expect(eventPut.Put?.Item).not.toHaveProperty('actorStaffId');
    expect(ticketUpdate.Update?.ExpressionAttributeValues).toMatchObject({
      ':prioritySetBy': 'AI',
    });
  });

  it('records a triage by hand as the manager who did it, with the reason', async () => {
    await applyTriage('tkt_1', 3, {
      ...update,
      staff: { accountId: 'manager@example.com', reason: 'Lift and lights' },
    });

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update?.ExpressionAttributeValues).toMatchObject({
      ':prioritySetBy': 'STAFF',
      ':teamStatusKey': 'TEAM#PLUMBING#STATUS#ASSIGNED',
    });
    expect(ticketUpdate.Update?.ConditionExpression).toBe(
      '#status = :received AND #version = :version',
    );
    expect(eventPut.Put?.Item).toMatchObject({
      kind: 'TRIAGED',
      actorType: 'STAFF',
      actorStaffId: 'manager@example.com',
      fromStatus: 'RECEIVED',
      toStatus: 'ASSIGNED',
      toPriority: 'MEDIUM',
      toTeamId: 'PLUMBING',
      note: 'Lift and lights',
    });
  });

  it('records a triage by hand without a reason without a note', async () => {
    await applyTriage('tkt_1', 3, {
      ...update,
      staff: { accountId: 'manager@example.com' },
    });
    const [, eventPut] = transactItems();
    expect(eventPut.Put?.Item).toMatchObject({
      actorType: 'STAFF',
      actorStaffId: 'manager@example.com',
    });
    expect(eventPut.Put?.Item).not.toHaveProperty('note');
  });

  it('leaves safety fields out of an ordinary triage', async () => {
    await applyTriage('tkt_1', 3, update);

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update?.UpdateExpression).not.toContain('safetyHazard');
    expect(ticketUpdate.Update?.ExpressionAttributeValues).not.toHaveProperty(
      ':hazard',
    );
    expect(eventPut.Put?.Item).not.toHaveProperty('note');
  });

  it('stores the hazard on the ticket and the note on the event', async () => {
    await applyTriage('tkt_1', 3, {
      ...update,
      priority: 'CRITICAL',
      safetyHazard: 'FIRE',
    });

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update?.UpdateExpression).toContain(
      'safetyHazard = :hazard',
    );
    expect(ticketUpdate.Update?.ExpressionAttributeValues).toMatchObject({
      ':hazard': 'FIRE',
      ':priority': 'CRITICAL',
    });
    expect(eventPut.Put?.Item).toMatchObject({
      toPriority: 'CRITICAL',
      note: 'SAFETY_OVERRIDE:FIRE',
    });
  });
});
