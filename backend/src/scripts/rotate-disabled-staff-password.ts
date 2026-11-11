import { pathToFileURL } from 'node:url';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { normalizeUsername } from '../shared/accounts.js';
import { ddb } from '../shared/dynamodb-client.js';
import { generatePassword, hashPassword } from '../shared/password.js';
import { tableName } from '../shared/tables.js';

/**
 * Recovers a disabled staff account after its generated password was exposed.
 * The conditional update cannot create an account or rotate an active one.
 * Incrementing tokenVersion invalidates all older staff sessions.
 */
export async function rotateDisabledStaffPassword(
  email: string,
): Promise<string> {
  const username = normalizeUsername(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(username)) {
    throw new Error('Provide a valid staff account email.');
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName('ACCOUNTS'),
        Key: { username },
        UpdateExpression:
          'SET passwordHash = :hash, passwordChangedAt = :now, updatedAt = :now, isActive = :active, failedLoginCount = :zero REMOVE lockedUntil ADD tokenVersion :one',
        ConditionExpression:
          'attribute_exists(#username) AND isActive = :disabled',
        ExpressionAttributeNames: { '#username': 'username' },
        ExpressionAttributeValues: {
          ':hash': passwordHash,
          ':now': now,
          ':active': true,
          ':disabled': false,
          ':zero': 0,
          ':one': 1,
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error('Account does not exist or is not disabled.', {
        cause: err,
      });
    }
    throw err;
  }

  return password;
}

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--email') {
      throw new Error('Usage: rotate:staff-password --email <staff-email>');
    }
    const email = process.argv[3];
    const password = await rotateDisabledStaffPassword(email);
    process.stdout.write(
      `Rotated ${normalizeUsername(email)}. New password (shown once): ${password}\n` +
        'Save it privately. Do not paste it into chat or commit it to Git.\n',
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
