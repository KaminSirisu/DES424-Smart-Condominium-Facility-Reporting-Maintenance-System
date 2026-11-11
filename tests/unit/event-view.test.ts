import { describe, expect, it } from 'vitest';
import { toEventView } from '../../backend/src/tickets/event-view';
import type { TicketEventRecord } from '../../backend/src/tickets/types';

describe('toEventView', () => {
  it('keeps the fields of the TicketEvent schema and nothing else', () => {
    const record = {
      id: 'tkt_1_status_v3',
      ticketId: 'tkt_1',
      kind: 'STATUS_CHANGED',
      occurredAt: '2026-11-05T09:00:00.000Z',
      actorType: 'STAFF',
      actorStaffId: 'plumbing@example.com',
      actorTeamId: 'PLUMBING',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'DONE',
      fromPriority: 'MEDIUM',
      toPriority: 'CRITICAL',
      fromTeamId: 'HVAC',
      toTeamId: 'PLUMBING',
      repairCycle: 1,
      proofPhotoId: 'upl_proof',
      note: 'Why',
      // not part of the schema: must not get out
      eventKey: '2026-11-05T09:00:00.000Z#tkt_1_status_v3',
      s3ObjectKey: 'uploads/REPAIR_PROOF/x/y',
    } as TicketEventRecord;

    const view = toEventView(record);

    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'ticketId',
        'kind',
        'occurredAt',
        'actorType',
        'actorStaffId',
        'actorTeamId',
        'fromStatus',
        'toStatus',
        'fromPriority',
        'toPriority',
        'fromTeamId',
        'toTeamId',
        'repairCycle',
        'proofPhotoId',
        'note',
      ].sort(),
    );
    expect(view).not.toHaveProperty('eventKey');
    expect(view).not.toHaveProperty('s3ObjectKey');
  });

  it('leaves out fields the event does not have', () => {
    expect(
      toEventView({
        id: 'tkt_1_created',
        ticketId: 'tkt_1',
        kind: 'CREATED',
        occurredAt: '2026-11-05T08:00:00.000Z',
        actorType: 'REPORTER',
        toStatus: 'RECEIVED',
      }),
    ).toEqual({
      id: 'tkt_1_created',
      ticketId: 'tkt_1',
      kind: 'CREATED',
      occurredAt: '2026-11-05T08:00:00.000Z',
      actorType: 'REPORTER',
      toStatus: 'RECEIVED',
    });
  });
});
