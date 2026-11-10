import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../../backend/src/shared/accounts';

vi.mock('../../backend/src/shared/teams', () => ({ getTeamName: vi.fn() }));

import { staffProfileOf } from '../../backend/src/shared/staff-profile';
import { getTeamName } from '../../backend/src/shared/teams';

const technician: AccountRecord = {
  accountId: 'plumbing@example.com',
  username: 'plumbing@example.com',
  role: 'TECHNICIAN',
  teamId: 'PLUMBING',
  displayName: 'Plumbing team',
  passwordHash: '$2b$12$secret-hash',
  isActive: true,
  tokenVersion: 3,
  failedLoginCount: 0,
  passwordChangedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const teamName = vi.mocked(getTeamName);

describe('staffProfileOf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('adds the team name for a technician', async () => {
    teamName.mockResolvedValue('Plumbing');

    await expect(staffProfileOf(technician)).resolves.toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
      teamName: 'Plumbing',
    });
    expect(teamName).toHaveBeenCalledWith('PLUMBING');
  });

  it('leaves the name out when the team has none', async () => {
    teamName.mockResolvedValue(null);

    const profile = await staffProfileOf(technician);

    expect(profile).toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'TECHNICIAN',
      teamId: 'PLUMBING',
    });
    expect(profile).not.toHaveProperty('teamName');
  });

  it('does not look up a team for a manager', async () => {
    const manager = { ...technician, role: 'MANAGER', teamId: undefined };

    const profile = await staffProfileOf(manager as AccountRecord);

    expect(profile).toEqual({
      id: 'plumbing@example.com',
      name: 'Plumbing team',
      role: 'MANAGER',
    });
    expect(teamName).not.toHaveBeenCalled();
  });

  it('still answers, without a name, when the Teams lookup fails', async () => {
    teamName.mockRejectedValue(new Error('throttled'));

    const profile = await staffProfileOf(technician);

    expect(profile).not.toHaveProperty('teamName');
    expect(profile.teamId).toBe('PLUMBING');
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('PLUMBING');
    expect(logged).not.toContain('secret-hash');
  });

  it('never carries a secret', async () => {
    teamName.mockResolvedValue('Plumbing');
    const text = JSON.stringify(await staffProfileOf(technician));
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain('tokenVersion');
  });
});
