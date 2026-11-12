/**
 * Whether a manager must use MFA (SR-09). On unless MANAGER_MFA_REQUIRED is
 * exactly `false` (any case), so a missing or misspelled value never switches
 * the second factor off. The `false` setting is for local development only.
 */
export function managerMfaRequired(): boolean {
  return process.env.MANAGER_MFA_REQUIRED?.trim().toLowerCase() !== 'false';
}
