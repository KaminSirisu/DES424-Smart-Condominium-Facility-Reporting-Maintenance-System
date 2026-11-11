import { readFile } from 'node:fs/promises';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;
const [ticketId, imagePath] = process.argv.slice(2);

if (!email || !password || !ticketId || !imagePath) {
  console.error(
    'Set technician STAFF_EMAIL and STAFF_PASSWORD privately, then run npm run test:smoke:staff-ticket-status -- <disposable-assigned-ticket-id> <jpeg-path>.',
  );
  process.exit(2);
}

const image = await readFile(imagePath);
if (
  image.length < 3 ||
  image[0] !== 0xff ||
  image[1] !== 0xd8 ||
  image[2] !== 0xff ||
  image.length > 10 * 1024 * 1024
) {
  throw new Error('Use a JPEG file no larger than 10 MiB for this smoke test.');
}

const ticketUrl = `${baseUrl}/tickets/${encodeURIComponent(ticketId)}`;
const statusUrl = `${ticketUrl}/status`;

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

const noAuth = await fetch(statusUrl, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'IN_PROGRESS' }),
});
if (noAuth.status !== 401) {
  throw new Error(
    `Unauthenticated PATCH returned HTTP ${noAuth.status}, expected 401.`,
  );
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

const headers = {
  authorization: `Bearer ${session.accessToken}`,
  'content-type': 'application/json',
};
const before = await responseJson(
  await fetch(ticketUrl, { headers }),
  200,
  'Ticket detail',
);
if (before.status !== 'ASSIGNED' || before.teamId !== session.staff.teamId) {
  throw new Error(
    'Use a disposable ASSIGNED ticket belonging to this technician team.',
  );
}

async function changeStatus(payload, step) {
  return responseJson(
    await fetch(statusUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    }),
    200,
    step,
  );
}

const started = await changeStatus({ status: 'IN_PROGRESS' }, 'Start repair');
if (started.status !== 'IN_PROGRESS' || started.id !== ticketId) {
  throw new Error('The ticket did not move to IN_PROGRESS.');
}
const repeated = await changeStatus(
  { status: 'IN_PROGRESS' },
  'Repeat start repair',
);
if (repeated.status !== 'IN_PROGRESS') {
  throw new Error('Repeating IN_PROGRESS was not idempotent.');
}

const grant = await responseJson(
  await fetch(`${baseUrl}/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      purpose: 'REPAIR_PROOF',
      contentType: 'image/jpeg',
      sizeBytes: image.length,
    }),
  }),
  201,
  'Repair-proof upload grant',
);
if (!grant.uploadId || !grant.uploadUrl || grant.method !== 'PUT') {
  throw new Error('Repair-proof upload grant is incomplete.');
}
const put = await fetch(grant.uploadUrl, {
  method: 'PUT',
  headers: { ...grant.headers, 'Content-Length': String(image.length) },
  body: image,
});
if (!put.ok) {
  throw new Error(`Repair-proof S3 upload returned HTTP ${put.status}.`);
}

const completed = await changeStatus(
  { status: 'DONE', proofPhotoUploadId: grant.uploadId },
  'Complete repair',
);
if (
  completed.status !== 'DONE' ||
  !completed.completedAt ||
  !completed.photos?.some(
    (photo) => photo.id === grant.uploadId && photo.purpose === 'REPAIR_PROOF',
  )
) {
  throw new Error(
    'The completed ticket is missing DONE status or repair proof.',
  );
}

const persisted = await responseJson(
  await fetch(ticketUrl, { headers }),
  200,
  'Completed ticket detail',
);
if (
  persisted.status !== 'DONE' ||
  !persisted.photos?.some((photo) => photo.id === grant.uploadId)
) {
  throw new Error('The DONE status or proof photo was not persisted.');
}
for (const body of [started, completed, persisted]) {
  const serialized = JSON.stringify(body);
  for (const privateField of [
    'reporterLineUserId',
    's3ObjectKey',
    'passwordHash',
  ]) {
    if (serialized.includes(`"${privateField}"`)) {
      throw new Error(
        `A private field was present in a ticket response: ${privateField}.`,
      );
    }
  }
}

console.log(
  `Staff status and proof upload passed for ${ticketId}: ASSIGNED -> IN_PROGRESS -> DONE.`,
);
