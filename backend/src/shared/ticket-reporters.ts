import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamodb-client.js';
import { tableName } from './tables.js';

/**
 * Reads the reporters associated with a ticket from the TicketReporters table
 * (SCFRMS-28: PK `ticketId`, SK `reporterLineUserId`). A ticket merged from
 * several reports has one item per reporter.
 */

/** The LINE user ids of every reporter of the ticket. Strongly consistent. */
export async function listReporterIds(ticketId: string): Promise<string[]> {
  const ids: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName('TICKET_REPORTERS'),
        KeyConditionExpression: 'ticketId = :ticketId',
        ExpressionAttributeValues: { ':ticketId': ticketId },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.reporterLineUserId === 'string') {
        ids.push(item.reporterLineUserId);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return ids;
}
