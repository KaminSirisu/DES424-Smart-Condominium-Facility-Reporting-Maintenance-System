import {
  toStaffProfile,
  type AccountRecord,
  type StaffProfile,
} from './accounts.js';
import { getTeamName } from './teams.js';

/**
 * The profile a staff member sees (StaffProfile in openapi.yaml): the account
 * without any secret, plus the team's name for a technician. A failed or empty
 * Teams lookup only leaves the name out; it never stops a login or `/me`.
 */
export async function staffProfileOf(
  account: AccountRecord,
): Promise<StaffProfile> {
  const profile = toStaffProfile(account);
  if (!account.teamId) return profile;

  try {
    const teamName = await getTeamName(account.teamId);
    return teamName ? { ...profile, teamName } : profile;
  } catch (err) {
    console.error('Team name lookup failed; profile sent without it', {
      teamId: account.teamId,
      err,
    });
    return profile;
  }
}
