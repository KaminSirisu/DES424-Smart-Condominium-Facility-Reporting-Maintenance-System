import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import {
  acceptTicket,
  changeTicketStatus,
} from '../../backend/src/shared/ticket-repository.js';
import type { TicketRecord } from '../../backend/src/tickets/types.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const NOW = '2026-11-05T09:00:00.000Z';

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
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uabc123',
    teamId: 'PLUMBING',
    createdAt: '2026-11-05T08:00:00.000Z',
    updatedAt: '2026-11-05T08:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TICKETS_TABLE_NAME', 'TestTickets');
  vi.stubEnv('TICKET_EVENTS_TABLE_NAME', 'TestEvents');
  vi.stubEnv('TICKET_PHOTOS_TABLE_NAME', 'TestPhotos');
  send.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe('acceptTicket', () => {
  it('records the account and writes an ACCEPTED event in one transaction', async () => {
    await acceptTicket(ticket(), 'acct_plumbing', NOW);

    expect(send).toHaveBeenCalledOnce();
    const [update, event] = items();
    expect(update.Update?.TableName).toBe('TestTickets');
    expect(update.Update?.Key).toEqual({ ticketId: 'tkt_1' });
    expect(update.Update?.UpdateExpression).toContain(
      'acceptedByStaffId = :account',
    );
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':account': 'acct_plumbing',
      ':now': NOW,
      ':version': 2,
    });
    expect(event.Put?.TableName).toBe('TestEvents');
    expect(event.Put?.Item).toMatchObject({
      ticketId: 'tkt_1',
      eventKey: `${NOW}#tkt_1_accepted_v3`,
      id: 'tkt_1_accepted_v3',
      kind: 'ACCEPTED',
      actorType: 'STAFF',
      actorStaffId: 'acct_plumbing',
      repairCycle: 1,
    });
    expect(event.Put?.Item).not.toHaveProperty('toStatus');
  });

  it('only works on an ASSIGNED ticket nobody accepted, at the version it read', async () => {
    await acceptTicket(ticket(), 'acct_plumbing', NOW);
    const condition = items()[0].Update?.ConditionExpression ?? '';
    expect(condition).toContain('#status = :assigned');
    expect(condition).toContain('#version = :version');
    expect(condition).toContain('attribute_not_exists(acceptedByStaffId)');
    expect(items()[0].Update?.ExpressionAttributeValues).toMatchObject({
      ':assigned': 'ASSIGNED',
    });
  });

  it('does not change the status', async () => {
    await acceptTicket(ticket(), 'acct_plumbing', NOW);
    expect(items()[0].Update?.UpdateExpression).not.toContain('#status = :to');
  });
});

describe('changeTicketStatus', () => {
  it('starts work: ASSIGNED to IN_PROGRESS, in the team IN_PROGRESS queue', async () => {
    await changeTicketStatus(ticket(), {
      to: 'IN_PROGRESS',
      accountId: 'acct_plumbing',
      now: NOW,
    });

    expect(items()).toHaveLength(2);
    const [update, event] = items();
    expect(update.Update?.ConditionExpression).toBe(
      '#status = :from AND #version = :version AND acceptedByStaffId = :account',
    );
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':from': 'ASSIGNED',
      ':to': 'IN_PROGRESS',
      ':version': 2,
      ':account': 'acct_plumbing',
      ':teamStatusKey': 'TEAM#PLUMBING#STATUS#IN_PROGRESS',
    });
    expect(update.Update?.UpdateExpression).not.toContain('REMOVE');
    expect(event.Put?.Item).toMatchObject({
      eventKey: `${NOW}#tkt_1_status_v3`,
      kind: 'STATUS_CHANGED',
      actorType: 'STAFF',
      actorStaffId: 'acct_plumbing',
      fromStatus: 'ASSIGNED',
      toStatus: 'IN_PROGRESS',
      repairCycle: 1,
    });
    expect(event.Put?.Item).not.toHaveProperty('proofPhotoId');
  });

  it('finishes work: IN_PROGRESS to DONE, leaves the queue and stores the proof photo', async () => {
    await changeTicketStatus(ticket({ status: 'IN_PROGRESS', version: 5 }), {
      to: 'DONE',
      accountId: 'acct_plumbing',
      now: NOW,
      proof: {
        photoId: 'upl_proof',
        s3ObjectKey: 'uploads/REPAIR_PROOF/acct_plumbing/upl_proof',
      },
    });

    expect(items()).toHaveLength(3);
    const [update, event, photo] = items();
    expect(update.Update?.UpdateExpression).toContain('completedAt = :now');
    expect(update.Update?.UpdateExpression).toContain('REMOVE teamStatusKey');
    expect(update.Update?.ExpressionAttributeValues).toMatchObject({
      ':from': 'IN_PROGRESS',
      ':to': 'DONE',
      ':version': 5,
    });
    expect(update.Update?.ExpressionAttributeValues).not.toHaveProperty(
      ':teamStatusKey',
    );
    expect(event.Put?.Item).toMatchObject({
      id: 'tkt_1_status_v6',
      kind: 'STATUS_CHANGED',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'DONE',
      proofPhotoId: 'upl_proof',
    });
    expect(photo.Put?.TableName).toBe('TestPhotos');
    expect(photo.Put?.Item).toEqual({
      ticketId: 'tkt_1',
      photoId: 'upl_proof',
      purpose: 'REPAIR_PROOF',
      addedAt: NOW,
      repairCycle: 1,
      s3ObjectKey: 'uploads/REPAIR_PROOF/acct_plumbing/upl_proof',
    });
    expect(photo.Put?.ConditionExpression).toBe(
      'attribute_not_exists(photoId)',
    );
  });

  it('refuses DONE without a proof photo before touching the database', async () => {
    await expect(
      changeTicketStatus(ticket({ status: 'IN_PROGRESS' }), {
        to: 'DONE',
        accountId: 'acct_plumbing',
        now: NOW,
      }),
    ).rejects.toThrow('needs a proof photo');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to start work on a ticket without a team', async () => {
    await expect(
      changeTicketStatus(ticket({ teamId: undefined }), {
        to: 'IN_PROGRESS',
        accountId: 'acct_plumbing',
        now: NOW,
      }),
    ).rejects.toThrow('has no team');
    expect(send).not.toHaveBeenCalled();
  });

  it('puts the ticket update first, so a failed condition is reported at index 0', async () => {
    await changeTicketStatus(ticket(), {
      to: 'IN_PROGRESS',
      accountId: 'acct_plumbing',
      now: NOW,
    });
    expect(items()[0].Update).toBeDefined();
  });
});
