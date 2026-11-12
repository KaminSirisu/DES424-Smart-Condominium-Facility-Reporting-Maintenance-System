import { afterEach, describe, expect, it, vi } from 'vitest';
import { managerMfaRequired } from '../../backend/src/shared/mfa-policy';

describe('managerMfaRequired', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on when the setting is missing', () => {
    vi.stubEnv('MANAGER_MFA_REQUIRED', undefined as unknown as string);
    expect(managerMfaRequired()).toBe(true);
  });

  it.each(['true', '', '0', 'no', 'off', 'flase', 'TRUE'])(
    'is on for %j',
    (value) => {
      vi.stubEnv('MANAGER_MFA_REQUIRED', value);
      expect(managerMfaRequired()).toBe(true);
    },
  );

  it.each(['false', 'FALSE', ' False '])('is off only for %j', (value) => {
    vi.stubEnv('MANAGER_MFA_REQUIRED', value);
    expect(managerMfaRequired()).toBe(false);
  });
});
