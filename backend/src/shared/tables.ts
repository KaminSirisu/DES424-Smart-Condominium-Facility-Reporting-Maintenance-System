/**
 * Names of the DynamoDB tables (SCFRMS-28), one environment variable each, so
 * the infrastructure decides the real names. Keys and indexes are in
 * docs/database/dynamodb-access-patterns.md and docs/database/implementation-notes.md.
 */

const TABLE_ENV = {
  TICKETS: 'TICKETS_TABLE_NAME',
  TICKET_REPORTERS: 'TICKET_REPORTERS_TABLE_NAME',
  TICKET_PHOTOS: 'TICKET_PHOTOS_TABLE_NAME',
  TICKET_EVENTS: 'TICKET_EVENTS_TABLE_NAME',
  NOTIFICATIONS: 'NOTIFICATIONS_TABLE_NAME',
  TEAMS: 'TEAMS_TABLE_NAME',
  ACCOUNTS: 'ACCOUNTS_TABLE_NAME',
  RATE_LIMITS: 'RATE_LIMITS_TABLE_NAME',
} as const;

export type TableId = keyof typeof TABLE_ENV;

export function tableName(table: TableId): string {
  const envName = TABLE_ENV[table];
  const name = process.env[envName];
  if (!name) {
    throw new Error(`${envName} environment variable is not set.`);
  }
  return name;
}
