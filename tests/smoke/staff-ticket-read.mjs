const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;
const [ticketId, teamId] = process.argv.slice(2);

if (!email || !password || !ticketId || !teamId) {
  console.error(
    'Set STAFF_EMAIL and STAFF_PASSWORD privately, then run npm run test:smoke:staff-ticket-read -- <ticket-id> <team-id>.',
  );
  process.exit(2);
}

const withoutToken = await fetch(
  `${baseUrl}/tickets?teamId=${encodeURIComponent(teamId)}`,
);
if (withoutToken.status !== 401) {
  throw new Error(
    `Ticket list without a token returned HTTP ${withoutToken.status}, expected 401.`,
  );
}

const login = await fetch(`${baseUrl}/auth/staff/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await login.json();
if (
  login.status !== 200 ||
  session.staff?.role !== 'MANAGER' ||
  !session.accessToken
) {
  throw new Error(
    `Staff login returned HTTP ${login.status} or did not return a manager session.`,
  );
}

const headers = { authorization: `Bearer ${session.accessToken}` };
const list = await fetch(
  `${baseUrl}/tickets?teamId=${encodeURIComponent(teamId)}`,
  { headers },
);
const page = await list.json();
if (list.status !== 200 || !Array.isArray(page.items)) {
  throw new Error(
    `Staff ticket list returned HTTP ${list.status} or an invalid page.`,
  );
}
if (!page.items.some((ticket) => ticket.id === ticketId)) {
  throw new Error(
    `Ticket ${ticketId} was not in the first ${teamId} team page.`,
  );
}

const detail = await fetch(
  `${baseUrl}/tickets/${encodeURIComponent(ticketId)}`,
  { headers },
);
const ticket = await detail.json();
if (
  detail.status !== 200 ||
  ticket.id !== ticketId ||
  !Array.isArray(ticket.photos)
) {
  throw new Error(
    `Staff ticket detail returned HTTP ${detail.status} or an invalid ticket.`,
  );
}

for (const body of [page, ticket]) {
  const text = JSON.stringify(body);
  for (const privateField of [
    'reporterLineUserId',
    's3ObjectKey',
    'passwordHash',
  ]) {
    if (text.includes(`"${privateField}"`)) {
      throw new Error(
        `A private field was present in a ticket response: ${privateField}.`,
      );
    }
  }
}

console.log(`Staff ticket list and detail passed for ${ticketId}.`);
