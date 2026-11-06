import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send: vi.fn() },
}));

import { ddb } from '../../backend/src/shared/dynamodb-client.js';
import { getTeamEmail, getTeamName } from '../../backend/src/shared/teams.js';

const send = vi.mocked(ddb.send) as unknown as ReturnType<typeof vi.fn>;

describe('getTeamEmail', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TEAMS_TABLE_NAME', 'TestTeams');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the email stored on the team record', async () => {
    send.mockResolvedValue({
      Item: { teamId: 'PLUMBING', email: 'plumbing@example.com' },
    });

    await expect(getTeamEmail('PLUMBING')).resolves.toBe(
      'plumbing@example.com',
    );
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestTeams',
      Key: { teamId: 'PLUMBING' },
    });
  });

  it.each([
    ['the team has no record', {}],
    ['the record has no email', { Item: { teamId: 'PLUMBING' } }],
    ['the email is not an address', { Item: { email: 'not-an-address' } }],
    ['the email is not a string', { Item: { email: 42 } }],
  ])('returns null when %s', async (_label, response) => {
    send.mockResolvedValue(response);
    await expect(getTeamEmail('PLUMBING')).resolves.toBeNull();
  });

  it('does not call DynamoDB while the Teams table is not configured', async () => {
    vi.stubEnv('TEAMS_TABLE_NAME', '');
    await expect(getTeamEmail('PLUMBING')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('rethrows a DynamoDB failure so the caller can retry', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(getTeamEmail('PLUMBING')).rejects.toThrow('throttled');
  });
});

describe('getTeamName', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TEAMS_TABLE_NAME', 'TestTeams');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the trimmed name stored on the team record', async () => {
    send.mockResolvedValue({
      Item: { teamId: 'PLUMBING', name: ' Plumbing ' },
    });

    await expect(getTeamName('PLUMBING')).resolves.toBe('Plumbing');
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'TestTeams',
      Key: { teamId: 'PLUMBING' },
    });
  });

  it.each([
    ['the team has no record', {}],
    ['the record has no name', { Item: { teamId: 'PLUMBING' } }],
    ['the name is empty', { Item: { name: '  ' } }],
    ['the name is not a string', { Item: { name: 42 } }],
  ])('returns null when %s', async (_label, response) => {
    send.mockResolvedValue(response);
    await expect(getTeamName('PLUMBING')).resolves.toBeNull();
  });

  it('does not call DynamoDB while the Teams table is not configured', async () => {
    vi.stubEnv('TEAMS_TABLE_NAME', '');
    await expect(getTeamName('PLUMBING')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('rethrows a DynamoDB failure', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(getTeamName('PLUMBING')).rejects.toThrow('throttled');
  });
});
