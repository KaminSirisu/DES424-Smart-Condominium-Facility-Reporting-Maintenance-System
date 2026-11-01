import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { applyTriage } from '../../backend/src/shared/ticket-repository.js';
import type { TriageUpdate } from '../../backend/src/shared/ticket-repository.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

const update: TriageUpdate = {
  category: 'PLUMBING',
  suggestedPriority: 'MEDIUM',
  priority: 'MEDIUM',
  teamId: 'PLUMBING',
  deadlineAt: '2026-10-29T10:00:00.000Z',
  slaPolicyVersion: 1,
  now: '2026-10-28T10:30:00.000Z',
};

function transactItems(): {
  Update: {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  Put: { Item: Record<string, unknown> };
}[] {
  return send.mock.calls[0][0].input.TransactItems;
}

describe('applyTriage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TABLE_NAME', 'TestTable');
    send.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it('updates the ticket and writes a TRIAGED event in one transaction', async () => {
    await applyTriage('tkt_1', 3, update);

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update.ConditionExpression).toBe(
      '#status = :received AND #version = :version',
    );
    expect(ticketUpdate.Update.ExpressionAttributeValues).toMatchObject({
      ':version': 3,
      ':priority': 'MEDIUM',
      ':gsi1pk': 'TEAM#PLUMBING',
      ':gsi1sk': 'DEADLINE#2026-10-29T10:00:00.000Z',
    });
    expect(eventPut.Put.Item).toMatchObject({
      SK: 'EVENT#2026-10-28T10:30:00.000Z#TRIAGED',
      kind: 'TRIAGED',
      toPriority: 'MEDIUM',
    });
  });

  it('leaves safety fields out of an ordinary triage', async () => {
    await applyTriage('tkt_1', 3, update);

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update.UpdateExpression).not.toContain('safetyHazard');
    expect(ticketUpdate.Update.ExpressionAttributeValues).not.toHaveProperty(
      ':hazard',
    );
    expect(eventPut.Put.Item).not.toHaveProperty('note');
  });

  it('stores the hazard on the ticket and the note on the event', async () => {
    await applyTriage('tkt_1', 3, {
      ...update,
      priority: 'CRITICAL',
      safetyHazard: 'FIRE',
    });

    const [ticketUpdate, eventPut] = transactItems();
    expect(ticketUpdate.Update.UpdateExpression).toContain(
      'safetyHazard = :hazard',
    );
    expect(ticketUpdate.Update.ExpressionAttributeValues).toMatchObject({
      ':hazard': 'FIRE',
      ':priority': 'CRITICAL',
    });
    expect(eventPut.Put.Item).toMatchObject({
      toPriority: 'CRITICAL',
      note: 'SAFETY_OVERRIDE:FIRE',
    });
  });
});
