import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCommand } from '@aws-sdk/lib-dynamodb';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../backend/src/shared/dynamodb-client.js', () => ({
  ddb: { send },
}));
vi.mock('../../backend/src/shared/password.js', () => ({
  generatePassword: () => 'a-fresh-generated-password',
  hashPassword: async () => '$2b$12$new-hash',
}));

import { rotateDisabledStaffPassword } from '../../backend/src/scripts/rotate-disabled-staff-password.js';

describe('disabled staff account recovery', () => {
  beforeEach(() => {
    send.mockReset();
    vi.stubEnv('ACCOUNTS_TABLE_NAME', 'test-Accounts');
  });

  it('sets only a hash, reactivates the account, and invalidates older tokens', async () => {
    send.mockResolvedValue({});

    const password = await rotateDisabledStaffPassword(' Manager@Example.com ');
    const command = send.mock.calls[0][0] as UpdateCommand;

    expect(password).toBe('a-fresh-generated-password');
    expect(command.input.TableName).toBe('test-Accounts');
    expect(command.input.Key).toEqual({ username: 'manager@example.com' });
    expect(command.input.ConditionExpression).toContain('isActive = :disabled');
    expect(command.input.UpdateExpression).toContain('ADD tokenVersion :one');
    expect(command.input.UpdateExpression).toContain('REMOVE lockedUntil');
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':hash': '$2b$12$new-hash',
      ':active': true,
      ':disabled': false,
      ':zero': 0,
      ':one': 1,
    });
    expect(JSON.stringify(command.input)).not.toContain(password);
  });

  it('does not return a password when the account is missing or active', async () => {
    send.mockRejectedValue({ name: 'ConditionalCheckFailedException' });

    await expect(
      rotateDisabledStaffPassword('manager@example.com'),
    ).rejects.toThrow('does not exist or is not disabled');
  });
});
