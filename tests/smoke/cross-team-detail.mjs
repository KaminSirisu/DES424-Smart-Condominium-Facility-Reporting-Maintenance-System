import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const ticketTable =
  process.env.TICKETS_TABLE_NAME ?? 'des424-g02-scfrms-dev-Tickets';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;
const [ownTicketId, otherTicketId, otherTeamId] = process.argv.slice(2);

if (!email || !password || !ownTicketId || !otherTicketId || !otherTeamId) {
  console.error(
    'Set technician STAFF_EMAIL and STAFF_PASSWORD privately, then run npm run test:smoke:cross-team-detail -- <own-ticket-id> <other-ticket-id> <other-team-id>. AWS read access to the Tickets table is required.',
  );
  process.exit(2);
}

// A nonexistent ticket also returns 404 to staff. Verify the fixture directly
// so a typo or an unchanged placeholder cannot make the access test pass.
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'ap-southeast-1',
});
const otherItem = await dynamodb.send(
  new GetItemCommand({
    TableName: ticketTable,
    Key: { ticketId: { S: otherTicketId } },
    ConsistentRead: true,
    ProjectionExpression: 'ticketId,teamId',
  }),
);
if (
  otherItem.Item?.ticketId?.S !== otherTicketId ||
  otherItem.Item.teamId?.S !== otherTeamId
) {
  throw new Error(
    `The other ticket must exist in ${ticketTable} and be assigned to ${otherTeamId}; check the ticket ID and triage result.`,
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

const session = await responseJson(
  await fetch(`${baseUrl}/auth/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }),
  200,
  'Technician login',
);

if (
  session.staff?.role !== 'TECHNICIAN' ||
  !session.staff.teamId ||
  !session.accessToken
) {
  throw new Error('Use a technician account with a team for this smoke test.');
}
if (session.staff.teamId === otherTeamId) {
  throw new Error('The other ticket must belong to a different team.');
}

const headers = { authorization: `Bearer ${session.accessToken}` };
const own = await responseJson(
  await fetch(`${baseUrl}/tickets/${encodeURIComponent(ownTicketId)}`, {
    headers,
  }),
  200,
  'Own-team ticket detail',
);
if (own.id !== ownTicketId || own.teamId !== session.staff.teamId) {
  throw new Error('The own-team ticket does not belong to this technician.');
}

const otherDetail = await responseJson(
  await fetch(`${baseUrl}/tickets/${encodeURIComponent(otherTicketId)}`, {
    headers,
  }),
  404,
  'Cross-team ticket detail',
);
if (otherDetail.error?.code !== 'NOT_FOUND') {
  throw new Error('Cross-team ticket detail did not return NOT_FOUND.');
}

const otherList = await responseJson(
  await fetch(`${baseUrl}/tickets?teamId=${encodeURIComponent(otherTeamId)}`, {
    headers,
  }),
  403,
  'Cross-team ticket list',
);
if (otherList.error?.code !== 'FORBIDDEN') {
  throw new Error('Cross-team ticket list did not return FORBIDDEN.');
}

console.log(
  `Cross-team access passed: own ${ownTicketId} visible; ${otherTeamId} ticket ${otherTicketId} hidden.`,
);
