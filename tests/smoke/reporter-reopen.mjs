import { randomUUID } from 'node:crypto';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const token = process.env.LINE_ID_TOKEN;
const [ticketId] = process.argv.slice(2);

if (!token || !ticketId) {
  console.error(
    'Set a fresh LINE_ID_TOKEN from the original reporter, then run npm run test:smoke:reporter-reopen -- <disposable-done-ticket-id>.',
  );
  process.exit(2);
}

async function responseJson(response, expected, step) {
  const raw = await response.text();
  if (response.status !== expected) {
    let code;
    try {
      code = JSON.parse(raw).error?.code;
    } catch {
      // The status alone identifies a non-JSON response.
    }
    throw new Error(
      `${step} returned HTTP ${response.status}${code ? ` (${code})` : ''}; expected ${expected}.`,
    );
  }
  return JSON.parse(raw);
}

const url = `${baseUrl}/tickets/${encodeURIComponent(ticketId)}`;
const auth = { authorization: `Bearer ${token}` };
const before = await responseJson(
  await fetch(url, { headers: auth }),
  200,
  'Reporter ticket detail',
);
if (before.id !== ticketId || before.status !== 'DONE') {
  throw new Error('Use a disposable DONE ticket belonging to this reporter.');
}

const reopenUrl = `${url}/reopen`;
const unauthenticated = await fetch(reopenUrl, { method: 'POST' });
if (unauthenticated.status !== 401) {
  throw new Error(
    `Unauthenticated reopen returned HTTP ${unauthenticated.status}; expected 401.`,
  );
}

const key = randomUUID();
const headers = {
  ...auth,
  'content-type': 'application/json',
  'idempotency-key': key,
};
const request = () =>
  fetch(reopenUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'Reporter reopen smoke test' }),
  });
const reopened = await responseJson(await request(), 200, 'Reopen ticket');
if (
  reopened.id !== ticketId ||
  reopened.status !== 'ASSIGNED' ||
  reopened.repairCycle !== before.repairCycle + 1 ||
  reopened.completedAt !== undefined
) {
  throw new Error('Reopen did not update status and repair cycle as expected.');
}

const retried = await responseJson(await request(), 200, 'Idempotent retry');
if (
  retried.id !== ticketId ||
  retried.status !== 'ASSIGNED' ||
  retried.repairCycle !== reopened.repairCycle
) {
  throw new Error('Idempotent retry changed the reopened ticket.');
}

const persisted = await responseJson(
  await fetch(url, { headers: auth }),
  200,
  'Persisted reporter ticket detail',
);
if (
  persisted.status !== 'ASSIGNED' ||
  persisted.repairCycle !== reopened.repairCycle
) {
  throw new Error('The reporter cannot see the persisted reopened ticket.');
}

console.log(`Reporter reopen and idempotent retry passed for ${ticketId}.`);
