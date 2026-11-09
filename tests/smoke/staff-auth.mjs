const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;

if (!email || !password) {
  console.error(
    'Set STAFF_EMAIL and STAFF_PASSWORD privately, then run npm run test:smoke:staff-auth.',
  );
  process.exit(2);
}

const unauthenticated = await fetch(`${baseUrl}/auth/staff/me`);
if (unauthenticated.status !== 401) {
  throw new Error(
    `/auth/staff/me without a token returned HTTP ${unauthenticated.status}, expected 401.`,
  );
}

const login = await fetch(`${baseUrl}/auth/staff/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await login.json();
if (login.status !== 200 || typeof session.accessToken !== 'string') {
  throw new Error(
    `Staff login returned HTTP ${login.status}: ${session.error?.code ?? 'unexpected response'}.`,
  );
}

const me = await fetch(`${baseUrl}/auth/staff/me`, {
  headers: { authorization: `Bearer ${session.accessToken}` },
});
const profile = await me.json();
if (
  me.status !== 200 ||
  !profile.id ||
  !['MANAGER', 'TECHNICIAN'].includes(profile.role) ||
  profile.id !== session.staff?.id ||
  'passwordHash' in profile
) {
  throw new Error(
    `/auth/staff/me returned HTTP ${me.status} or an invalid profile.`,
  );
}

console.log(`Staff login and /me passed for role ${profile.role}.`);
