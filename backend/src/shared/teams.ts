import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';

/**
 * Reads maintenance team records from the Teams table (SCFRMS-28):
 * PK `teamId`, with `email` (the team's work order inbox) added by SCFRMS-46.
 */

/**
 * The work order address stored for a team, or null if the team has no record
 * or no usable address. While TEAMS_TABLE_NAME is not set (the table does not
 * exist yet) this returns null without calling DynamoDB, and the caller falls
 * back to the TEAM_EMAILS environment variable.
 */
export async function getTeamEmail(teamId: string): Promise<string | null> {
  if (!process.env.TEAMS_TABLE_NAME) return null;

  const result = await ddb.send(
    new GetCommand({ TableName: tableName('TEAMS'), Key: { teamId } }),
  );
  const email: unknown = result.Item?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
}
