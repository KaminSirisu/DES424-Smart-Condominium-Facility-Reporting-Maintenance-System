const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;
const [ticketId] = process.argv.slice(2);

if (!email || !password || !ticketId) {
  console.error(
    'Set technician STAFF_EMAIL and STAFF_PASSWORD privately, then run npm run test:smoke:staff-completed-list -- <completed-ticket-id>.',
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

const teamId = session.staff.teamId;
const headers = { authorization: `Bearer ${session.accessToken}` };
const ticket = await responseJson(
  await fetch(`${baseUrl}/tickets/${encodeURIComponent(ticketId)}`, {
    headers,
  }),
  200,
  'Completed ticket detail',
);
if (ticket.status !== 'DONE' || ticket.teamId !== teamId) {
  throw new Error('Use a DONE ticket assigned to this technician team.');
}

const otherTeam = teamId === 'ELECTRICAL' ? 'PLUMBING' : 'ELECTRICAL';
const denied = await fetch(
  `${baseUrl}/tickets?teamId=${encodeURIComponent(otherTeam)}&status=DONE`,
  { headers },
);
if (denied.status !== 403) {
  throw new Error(
    `Cross-team list returned HTTP ${denied.status}, expected 403.`,
  );
}

const mixed = await fetch(`${baseUrl}/tickets?status=DONE&status=ASSIGNED`, {
  headers,
});
if (mixed.status !== 422) {
  throw new Error(
    `Mixed completed/open list returned HTTP ${mixed.status}, expected 422.`,
  );
}

async function findTicket(query, step) {
  let cursor;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const params = new URLSearchParams({ ...query, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const page = await responseJson(
      await fetch(`${baseUrl}/tickets?${params}`, { headers }),
      200,
      step,
    );
    if (!Array.isArray(page.items)) {
      throw new Error(`${step} returned an invalid ticket page.`);
    }
    for (const item of page.items) {
      if (item.teamId !== teamId) {
        throw new Error(`${step} exposed another team's ticket.`);
      }
      const serialized = JSON.stringify(item);
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
    const found = page.items.find((item) => item.id === ticketId);
    if (found) return found;
    cursor = page.nextCursor;
    if (!cursor) return undefined;
  }
  throw new Error(`${step} exceeded 20 pages before finding ${ticketId}.`);
}

const completed = await findTicket({ status: 'DONE' }, 'Completed list');
if (completed?.status !== 'DONE') {
  throw new Error(`${ticketId} was not in this team's completed list.`);
}
const open = await findTicket({}, 'Open list');
if (open) {
  throw new Error(`${ticketId} still appeared in this team's open list.`);
}

console.log(
  `Completed list and team scope passed for ${ticketId} (${teamId}).`,
);
