import { randomUUID } from 'node:crypto';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const [mode, ...args] = process.argv.slice(2);
const execute = args.includes('--execute');
const values = args.filter((arg) => arg !== '--execute');

const usage = `Remaining live API smoke checks (M1-M9):
  npm run test:smoke:extended -- inspect <canonical-id> <source-id>       M1, M2; read only
  npm run test:smoke:extended -- dashboard <ticket-id>                  M6; read only
  npm run test:smoke:extended -- priority <other-ticket-id> <priority> --execute     M3
  npm run test:smoke:extended -- assignment <other-ticket-id> <team-id> --execute   M4
  npm run test:smoke:extended -- merge <canonical-id> <source-id> --execute         M5
  npm run test:smoke:extended -- accounts <new-test-email> --execute                M7, M8
  npm run test:smoke:extended -- triage <received-id> <team-id> <priority> --execute M9

Set STAFF_EMAIL to the manager or relevant technician email. The script prompts
for STAFF_PASSWORD if absent and for the manager's current MFA code. It never
prints session tokens, MFA codes, or a new account's one-time password.
Use only disposable tickets for commands with --execute. Inspect and merge must
run before either ticket is completed or reassigned.`;

if (!mode || mode === '--help' || mode === 'help') {
  console.log(usage);
  process.exit(mode ? 0 : 2);
}

const arities = {
  inspect: 2,
  dashboard: 1,
  priority: 2,
  assignment: 2,
  merge: 2,
  accounts: 1,
  triage: 3,
};
if (
  values.length !== arities[mode] ||
  (mode !== 'inspect' && mode !== 'dashboard' && !execute)
) {
  console.error(usage);
  process.exit(2);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ticketPath(id, suffix = '') {
  return `/tickets/${encodeURIComponent(id)}${suffix}`;
}

async function request(
  path,
  { token, method = 'GET', body, headers = {}, expected = 200 } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `${method} ${path} returned non-JSON HTTP ${response.status}.`,
    );
  }
  if (response.status !== expected) {
    throw new Error(
      `${method} ${path} returned HTTP ${response.status}` +
        `${data.error?.code ? ` (${data.error.code})` : ''}; expected ${expected}.`,
    );
  }
  return data;
}

function hidden(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error('Run this script in an interactive CloudShell terminal.');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data) => {
      for (const character of data.toString()) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('Canceled.'));
        if (character === '\u007f') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function staffLogin(requiredRole) {
  const email = process.env.STAFF_EMAIL;
  assert(email, 'Set STAFF_EMAIL to the manager or assigned technician email.');
  const password =
    process.env.STAFF_PASSWORD ?? (await hidden('Staff password (hidden): '));
  assert(password, 'Staff password is required.');
  const login = await request('/auth/staff/login', {
    method: 'POST',
    body: { email, password },
  });
  let session = login;
  if (login.mfaRequired === true) {
    assert(
      login.mfaEnrolled === true,
      'Complete manager MFA enrollment before these smoke checks.',
    );
    assert(
      typeof login.challengeToken === 'string',
      'Manager login did not return an MFA challenge.',
    );
    const code = await hidden(
      'Current six-digit authenticator code (hidden): ',
    );
    assert(
      /^\d{6}$/.test(code),
      'Enter the six-digit code currently shown in the authenticator app.',
    );
    session = await request('/auth/staff/mfa/verify', {
      method: 'POST',
      body: { challengeToken: login.challengeToken, code },
    });
  }
  assert(
    typeof session.accessToken === 'string',
    'Staff login did not return a session.',
  );
  assert(
    session.staff?.role === requiredRole || requiredRole === 'ANY',
    `Use a ${requiredRole} account for ${mode}.`,
  );
  return { token: session.accessToken, staff: session.staff };
}

async function getTicket(id, token) {
  const ticket = await request(ticketPath(id), { token });
  assert(ticket.id === id, `Ticket detail did not return ${id}.`);
  return ticket;
}

async function pages(path, token, limit = 100) {
  const items = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const separator = path.includes('?') ? '&' : '?';
    const current = await request(
      `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { token },
    );
    assert(
      Array.isArray(current.items),
      `${path} did not return an items array.`,
    );
    items.push(...current.items);
    if (!current.nextCursor) return items;
    assert(
      current.nextCursor !== cursor,
      `${path} returned the same cursor twice.`,
    );
    cursor = current.nextCursor;
  }
  throw new Error(
    `${path} exceeded 20 pages; narrow the fixture or increase the test bound.`,
  );
}

async function eventKinds(id, token) {
  return (await pages(ticketPath(id, '/events'), token, 1)).map(
    (event) => event.kind,
  );
}

async function inspect(canonicalId, sourceId) {
  const { token, staff } = await staffLogin('ANY');
  const [canonical, source] = await Promise.all([
    getTicket(canonicalId, token),
    getTicket(sourceId, token),
  ]);
  assert(canonicalId !== sourceId, 'Use two different tickets.');
  assert(
    ['ASSIGNED', 'IN_PROGRESS'].includes(canonical.status) &&
      ['ASSIGNED', 'IN_PROGRESS'].includes(source.status),
    'Both tickets must still be open (ASSIGNED or IN_PROGRESS).',
  );
  assert(
    canonical.teamId === source.teamId &&
      canonical.location === source.location,
    'Tickets must have the same assigned team and exact location text.',
  );
  if (staff.role === 'TECHNICIAN') {
    assert(
      staff.teamId === canonical.teamId,
      'Use the technician account of the assigned team.',
    );
  }

  const events = await pages(ticketPath(canonicalId, '/events'), token, 1);
  const kinds = events.map((event) => event.kind);
  assert(
    kinds.includes('CREATED') && kinds.includes('TRIAGED'),
    'M1: expected CREATED and TRIAGED in the audit history.',
  );
  assert(
    events.every(
      (event, index) =>
        index === 0 ||
        Date.parse(events[index - 1].occurredAt) <=
          Date.parse(event.occurredAt),
    ),
    'M1: audit events were not returned oldest first.',
  );
  const [fromCanonical, fromSource] = await Promise.all([
    pages(ticketPath(canonicalId, '/duplicates'), token),
    pages(ticketPath(sourceId, '/duplicates'), token),
  ]);
  assert(
    fromCanonical.some((ticket) => ticket.id === sourceId),
    'M2: source ticket was not suggested.',
  );
  assert(
    fromSource.some((ticket) => ticket.id === canonicalId),
    'M2: canonical ticket was not suggested.',
  );
  assert(
    !fromCanonical.some((ticket) => ticket.id === canonicalId) &&
      !fromSource.some((ticket) => ticket.id === sourceId),
    'M2: a ticket suggested itself.',
  );
  console.log(
    `M1/M2 passed: history readable; ${canonicalId} and ${sourceId} suggest each other.`,
  );
}

async function priority(id, target) {
  assert(
    ['CRITICAL', 'MEDIUM', 'LOW'].includes(target),
    'Priority must be CRITICAL, MEDIUM or LOW.',
  );
  const { token } = await staffLogin('ANY');
  const before = await getTicket(id, token);
  assert(
    ['ASSIGNED', 'IN_PROGRESS'].includes(before.status),
    'M3 needs a separate open ticket.',
  );
  assert(
    before.priority !== target,
    `M3 target must differ from current priority ${before.priority}.`,
  );
  await request(ticketPath(id, '/priority'), {
    token,
    method: 'PATCH',
    body: { priority: target },
    expected: 400,
  });
  const updated = await request(ticketPath(id, '/priority'), {
    token,
    method: 'PATCH',
    body: { priority: target, reason: 'Live smoke priority correction' },
  });
  assert(
    updated.priority === target && updated.prioritySetBy === 'STAFF',
    'M3 priority update did not persist.',
  );
  assert(
    typeof updated.deadlineAt === 'string',
    'M3 did not return a recalculated deadline.',
  );
  const repeated = await request(ticketPath(id, '/priority'), {
    token,
    method: 'PATCH',
    body: { priority: target, reason: 'Live smoke priority correction' },
  });
  assert(
    repeated.priority === target,
    'M3 retry changed the priority unexpectedly.',
  );
  assert(
    (await eventKinds(id, token)).includes('PRIORITY_CHANGED'),
    'M3 priority event is missing.',
  );
  console.log(
    `M3 passed: ${id} priority ${before.priority} -> ${target}; retry remained ${target}.`,
  );
}

async function assignment(id, targetTeam) {
  const { token } = await staffLogin('MANAGER');
  const before = await getTicket(id, token);
  assert(
    before.status === 'ASSIGNED',
    'M4 needs a separate ASSIGNED ticket that has not started work.',
  );
  assert(
    before.teamId !== targetTeam,
    'M4 target team must differ from current team.',
  );
  await request(ticketPath(id, '/assignment'), {
    token,
    method: 'PATCH',
    body: { teamId: targetTeam },
    expected: 400,
  });
  const updated = await request(ticketPath(id, '/assignment'), {
    token,
    method: 'PATCH',
    body: { teamId: targetTeam, reason: 'Live smoke reassignment' },
  });
  assert(
    updated.teamId === targetTeam && updated.category === before.category,
    'M4 team did not change or category changed unexpectedly.',
  );
  assert(
    (await getTicket(id, token)).teamId === targetTeam,
    'M4 reassignment was not persisted.',
  );
  assert(
    (await eventKinds(id, token)).includes('REASSIGNED'),
    'M4 reassignment event is missing.',
  );
  console.log(
    `M4 passed: ${id} reassigned ${before.teamId} -> ${targetTeam}; category preserved.`,
  );
}

async function merge(canonicalId, sourceId) {
  const { token, staff } = await staffLogin('TECHNICIAN');
  const [canonical, source] = await Promise.all([
    getTicket(canonicalId, token),
    getTicket(sourceId, token),
  ]);
  assert(
    canonicalId !== sourceId,
    'Use different canonical and source tickets.',
  );
  assert(
    ['ASSIGNED', 'IN_PROGRESS'].includes(canonical.status) &&
      ['ASSIGNED', 'IN_PROGRESS'].includes(source.status),
    'M5 requires two open tickets.',
  );
  assert(
    canonical.teamId === staff.teamId && source.teamId === staff.teamId,
    'M5 requires the assigned team technician account.',
  );
  assert(
    canonical.location === source.location,
    'Confirm the reports share the exact location before merging.',
  );
  const key = randomUUID();
  const options = {
    token,
    method: 'POST',
    body: { sourceTicketIds: [sourceId] },
    headers: { 'idempotency-key': key },
  };
  const merged = await request(ticketPath(canonicalId, '/merge'), options);
  assert(
    merged.id === canonicalId &&
      ['ASSIGNED', 'IN_PROGRESS'].includes(merged.status),
    'M5 canonical ticket is not still open.',
  );
  const sourceAfter = await getTicket(sourceId, token);
  assert(
    sourceAfter.status === 'MERGED' &&
      sourceAfter.mergedIntoTicketId === canonicalId,
    'M5 source was not marked MERGED into the canonical ticket.',
  );
  const repeated = await request(ticketPath(canonicalId, '/merge'), options);
  assert(
    repeated.id === canonicalId,
    'M5 idempotent retry did not return the canonical ticket.',
  );
  console.log(
    `M5 passed: ${sourceId} merged into ${canonicalId}; same-key retry returned 200.`,
  );
}

async function dashboard(id) {
  const { token } = await staffLogin('MANAGER');
  const ticket = await getTicket(id, token);
  const summary = await request('/dashboard/summary', { token });
  assert(
    Number.isInteger(summary.openCount) && Array.isArray(summary.teamWorkloads),
    'M6 dashboard summary shape is incomplete.',
  );
  const query = new URLSearchParams({
    teamId: ticket.teamId,
    location: ticket.location,
  });
  const entries = await pages(`/dashboard/history?${query}`, token, 10);
  assert(
    entries.some((entry) => entry.ticket?.id === id),
    'M6 history did not include the known ticket.',
  );
  console.log(`M6 passed: dashboard summary and history include ${id}.`);
}

async function accounts(email) {
  assert(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    'Supply a new test-only email address you control.',
  );
  const { token } = await staffLogin('MANAGER');
  const before = await request('/staff-accounts', { token });
  assert(Array.isArray(before.items), 'M7 staff list is invalid.');
  assert(
    !before.items.some(
      (item) => item.email?.toLowerCase() === email.toLowerCase(),
    ),
    'M7 email already exists; use a new test-only address.',
  );

  let createdId;
  let disabled = false;
  try {
    const created = await request('/staff-accounts', {
      token,
      method: 'POST',
      expected: 201,
      body: { email, role: 'MANAGER', displayName: 'Smoke Test Manager' },
    });
    createdId = created.account?.accountId;
    assert(
      createdId &&
        created.account?.role === 'MANAGER' &&
        typeof created.temporaryPassword === 'string',
      'M7 create response is incomplete.',
    );
    const changed = await request(
      `/staff-accounts/${encodeURIComponent(createdId)}`,
      {
        token,
        method: 'PATCH',
        body: { action: 'SET_ACTIVE', isActive: false },
      },
    );
    disabled = changed.account?.isActive === false;
    assert(disabled, 'M8 test account was not deactivated.');
    const after = await request('/staff-accounts', { token });
    const account = after.items?.find((item) => item.accountId === createdId);
    assert(
      account?.isActive === false &&
        !('passwordHash' in account) &&
        !('mfaSecret' in account),
      'M8 account list is missing the disabled account or exposes a secret.',
    );
    console.log(
      `M7/M8 passed: test manager ${createdId} created and deactivated.`,
    );
  } finally {
    if (createdId && !disabled) {
      try {
        await request(`/staff-accounts/${encodeURIComponent(createdId)}`, {
          token,
          method: 'PATCH',
          body: { action: 'SET_ACTIVE', isActive: false },
        });
        console.error(
          `Cleanup: test manager ${createdId} deactivated after an incomplete check.`,
        );
      } catch {
        console.error(
          `Cleanup needed: deactivate test manager ${createdId} manually.`,
        );
      }
    }
  }
}

async function triage(id, teamId, targetPriority) {
  assert(
    ['CRITICAL', 'MEDIUM', 'LOW'].includes(targetPriority),
    'Priority must be CRITICAL, MEDIUM or LOW.',
  );
  const { token } = await staffLogin('MANAGER');
  const before = await getTicket(id, token);
  const options = {
    token,
    method: 'PATCH',
    body: {
      teamId,
      priority: targetPriority,
      reason: 'Live smoke manual triage',
    },
  };
  if (before.status !== 'RECEIVED') {
    assert(
      before.status === 'ASSIGNED',
      'M9 guard check expects a currently ASSIGNED ticket.',
    );
    const guard = await request(ticketPath(id, '/triage'), {
      ...options,
      expected: 409,
    });
    assert(guard.error?.code, 'M9 guard response has no error code.');
    console.log(
      `M9 guard passed: ${id} is already ASSIGNED; manual triage correctly returned 409.`,
    );
    console.log(
      'M9 success path remains pending until a genuine RECEIVED ticket is available.',
    );
    return;
  }
  const updated = await request(ticketPath(id, '/triage'), options);
  assert(
    updated.status === 'ASSIGNED' &&
      updated.teamId === teamId &&
      updated.priority === targetPriority &&
      updated.prioritySetBy === 'STAFF',
    'M9 manual triage did not assign the requested team and priority.',
  );
  assert(
    (await eventKinds(id, token)).includes('TRIAGED'),
    'M9 TRIAGED event is missing.',
  );
  console.log(
    `M9 passed: ${id} manually triaged to ${teamId}/${targetPriority}.`,
  );
}

const actions = {
  inspect,
  dashboard,
  priority,
  assignment,
  merge,
  accounts,
  triage,
};
try {
  await actions[mode](...values);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke check failed.');
  process.exitCode = 1;
}
