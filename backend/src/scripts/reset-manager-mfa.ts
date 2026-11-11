import { pathToFileURL } from 'node:url';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { accountEventPut } from '../shared/account-management.js';
import { normalizeUsername } from '../shared/accounts.js';
import { ddb } from '../shared/dynamodb-client.js';
import { tableName } from '../shared/tables.js';

/**
 * Removes a manager's authenticator from the command line, for the case that
 * no other manager can do it through PATCH /staff-accounts/{id} (a manager
 * cannot reset their own MFA, so the only manager who lost the authenticator
 * needs this). Whoever runs it needs AWS access to the Accounts and
 * AccountEvents tables, which is the same trust as the seed script.
 *
 * The conditional update touches only a MANAGER account that has an
 * authenticator or an unfinished setup. It raises tokenVersion, which ends
 * every session of the account, and the audit event names this script as the
 * actor. The next login sets up a new authenticator.
 */

export const SCRIPT_ACTOR = 'script:reset-manager-mfa';

export async function resetManagerMfa(
  email: string,
  now: Date = new Date(),
): Promise<string> {
  const username = normalizeUsername(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(username)) {
    throw new Error('Provide a valid manager account email.');
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName('ACCOUNTS'),
              Key: { username },
              UpdateExpression:
                'SET updatedAt = :now ADD tokenVersion :one REMOVE mfaSecret, mfaPendingSecret, mfaEnrolledAt, mfaLastStep',
              ConditionExpression:
                'attribute_exists(#username) AND #role = :manager AND (attribute_exists(mfaSecret) OR attribute_exists(mfaPendingSecret))',
              ExpressionAttributeNames: {
                '#username': 'username',
                '#role': 'role',
              },
              ExpressionAttributeValues: {
                ':now': now.toISOString(),
                ':one': 1,
                ':manager': 'MANAGER',
              },
            },
          },
          accountEventPut(username, 'MFA_RESET', SCRIPT_ACTOR, now),
        ],
      }),
    );
  } catch (err) {
    const e = err as {
      name?: string;
      CancellationReasons?: { Code?: string }[];
    };
    if (
      e?.name === 'TransactionCanceledException' &&
      e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      throw new Error(
        'Account does not exist, is not a manager, or has no MFA set up.',
        { cause: err },
      );
    }
    throw err;
  }
  return username;
}

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--email') {
      throw new Error('Usage: reset:manager-mfa --email <manager-email>');
    }
    const username = await resetManagerMfa(process.argv[3]);
    process.stdout.write(
      `Removed the MFA of ${username} and ended its sessions.\n` +
        'The manager sets up a new authenticator at the next login.\n',
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
