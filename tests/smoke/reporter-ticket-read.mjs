const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const token = process.env.LINE_ID_TOKEN;
const [ticketId] = process.argv.slice(2);

if (!token || !ticketId) {
  console.error(
    'Set a fresh LINE_ID_TOKEN from the reporter who created the ticket, then run npm run test:smoke:reporter-ticket-read -- <ticket-id>.',
  );
  process.exit(2);
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

function noPrivateFields(body, step) {
  const serialized = JSON.stringify(body);
  for (const privateField of [
    'reporterLineUserId',
    's3ObjectKey',
    'passwordHash',
  ]) {
    if (serialized.includes(`"${privateField}"`)) {
      throw new Error(`${step} exposed ${privateField}.`);
    }
  }
}

const ticketUrl = `${baseUrl}/tickets/${encodeURIComponent(ticketId)}`;
const noAuth = await fetch(ticketUrl);
if (noAuth.status !== 401) {
  throw new Error(
    `Unauthenticated ticket detail returned HTTP ${noAuth.status}, expected 401.`,
  );
}

const headers = { authorization: `Bearer ${token}` };
const ticket = await responseJson(
  await fetch(ticketUrl, { headers }),
  200,
  'Reporter ticket detail',
);
if (
  ticket.id !== ticketId ||
  ticket.status !== 'DONE' ||
  !Array.isArray(ticket.photos)
) {
  throw new Error('Expected the completed ticket and its photo metadata.');
}
noPrivateFields(ticket, 'Reporter ticket detail');

const staffFilter = await fetch(`${baseUrl}/tickets?teamId=PLUMBING`, {
  headers,
});
if (staffFilter.status !== 403) {
  throw new Error(
    `Reporter use of teamId returned HTTP ${staffFilter.status}, expected 403.`,
  );
}

let cursor;
let listed = false;
for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
  const params = new URLSearchParams({ status: 'DONE', limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const page = await responseJson(
    await fetch(`${baseUrl}/tickets?${params}`, { headers }),
    200,
    'Reporter completed list',
  );
  if (!Array.isArray(page.items)) {
    throw new Error('Reporter completed list returned an invalid page.');
  }
  noPrivateFields(page, 'Reporter completed list');
  if (page.items.some((item) => item.id === ticketId)) {
    listed = true;
    break;
  }
  cursor = page.nextCursor;
  if (!cursor) break;
}
if (!listed) {
  throw new Error(`${ticketId} was not in this reporter's completed list.`);
}

console.log(`Reporter ticket list and detail passed for ${ticketId}.`);
