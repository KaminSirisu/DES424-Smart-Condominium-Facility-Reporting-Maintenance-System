import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const ticketTable =
  process.env.TICKETS_TABLE_NAME ?? 'des424-g02-scfrms-dev-Tickets';
const reporterTable =
  process.env.TICKET_REPORTERS_TABLE_NAME ??
  'des424-g02-scfrms-dev-TicketReporters';
const token = process.env.LINE_ID_TOKEN;
const [ticketId] = process.argv.slice(2);

if (!token || !ticketId) {
  console.error(
    'Set a fresh LINE_ID_TOKEN from a different LINE user privately, then run npm run test:smoke:reporter-isolation -- <existing-ticket-id>. AWS read access to the ticket tables is required.',
  );
  process.exit(2);
}

let lineUserId;
try {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid ID token shape.');
  lineUserId = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).sub;
} catch {
  throw new Error('LINE_ID_TOKEN is not a LINE ID token.');
}
if (typeof lineUserId !== 'string' || lineUserId.length === 0) {
  throw new Error('LINE_ID_TOKEN has no LINE user ID.');
}

// A nonexistent ticket also returns 404. Verify the fixture exists and the
// second reporter is not associated with it before testing API isolation.
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'ap-southeast-1',
});
const ticket = await dynamodb.send(
  new GetItemCommand({
    TableName: ticketTable,
    Key: { ticketId: { S: ticketId } },
    ConsistentRead: true,
    ProjectionExpression: 'ticketId',
  }),
);
if (ticket.Item?.ticketId?.S !== ticketId) {
  throw new Error(`Ticket ${ticketId} does not exist in ${ticketTable}.`);
}
const link = await dynamodb.send(
  new GetItemCommand({
    TableName: reporterTable,
    Key: {
      ticketId: { S: ticketId },
      reporterLineUserId: { S: lineUserId },
    },
    ConsistentRead: true,
    ProjectionExpression: 'ticketId',
  }),
);
if (link.Item) {
  throw new Error(
    'This LINE account is already associated with the ticket; use a different reporter account.',
  );
}

async function responseJson(response, expected, step) {
  const raw = await response.text();
  if (response.status !== expected) {
    const code = (() => {
      try {
        return JSON.parse(raw).error?.code;
      } catch {
        return undefined;
      }
    })();
    throw new Error(
      `${step} returned HTTP ${response.status}${code ? ` (${code})` : ''}; expected ${expected}.`,
    );
  }
  return JSON.parse(raw);
}

const headers = { authorization: `Bearer ${token}` };
const detail = await responseJson(
  await fetch(`${baseUrl}/tickets/${encodeURIComponent(ticketId)}`, {
    headers,
  }),
  404,
  'Other reporter ticket detail',
);
if (detail.error?.code !== 'NOT_FOUND') {
  throw new Error('Other reporter ticket detail did not return NOT_FOUND.');
}

let cursor;
for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
  const params = new URLSearchParams({ limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const page = await responseJson(
    await fetch(`${baseUrl}/tickets?${params}`, { headers }),
    200,
    'Other reporter ticket list',
  );
  if (!Array.isArray(page.items)) {
    throw new Error('Other reporter ticket list is not a ticket page.');
  }
  if (page.items.some((item) => item.id === ticketId)) {
    throw new Error('Other reporter ticket list exposed the ticket.');
  }
  cursor = page.nextCursor;
  if (!cursor) {
    console.log(
      `Reporter isolation passed: other LINE account cannot read or list ${ticketId}.`,
    );
    process.exit(0);
  }
}
throw new Error(
  'Other reporter list exceeded 20 pages; isolation is unproven.',
);
