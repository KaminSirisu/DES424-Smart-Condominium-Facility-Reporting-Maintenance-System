const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const email = process.env.STAFF_EMAIL;
const password = process.env.STAFF_PASSWORD;

if (!email || !password || !process.stdin.isTTY) {
  console.error(
    'Set manager STAFF_EMAIL and STAFF_PASSWORD privately and run npm run test:smoke:manager-mfa in an interactive terminal.',
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

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function hiddenCode() {
  process.stdout.write('Current six-digit authenticator code (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let code = '';
    const finish = (result, error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (data) => {
      for (const char of data.toString()) {
        if (char === '\r' || char === '\n') {
          finish(code);
          return;
        }
        if (char === '\u0003') {
          finish(undefined, new Error('Canceled.'));
          return;
        }
        if (char === '\u007f') code = code.slice(0, -1);
        else if (/^[0-9]$/.test(char)) code += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

const challenge = await responseJson(
  await post('/auth/staff/login', { email, password }),
  200,
  'Manager password step',
);
if (
  challenge.mfaRequired !== true ||
  typeof challenge.challengeToken !== 'string' ||
  typeof challenge.mfaEnrolled !== 'boolean'
) {
  throw new Error('This account did not return a manager MFA challenge.');
}

if (!challenge.mfaEnrolled) {
  const enrollment = await responseJson(
    await post('/auth/staff/mfa/enroll', {
      challengeToken: challenge.challengeToken,
    }),
    200,
    'Manager MFA enrollment',
  );
  if (typeof enrollment.secret !== 'string') {
    throw new Error('Enrollment did not provide a setup key.');
  }
  console.log('Add this one-time setup key to your authenticator app now:');
  console.log(enrollment.secret);
  console.log('Do not paste the key into chat, issue trackers, or test logs.');
}

const code = await hiddenCode();
if (!/^\d{6}$/.test(code)) {
  throw new Error('Enter exactly six digits from the authenticator app.');
}
const step = challenge.mfaEnrolled ? 'verify' : 'confirm';
const session = await responseJson(
  await post(`/auth/staff/mfa/${step}`, {
    challengeToken: challenge.challengeToken,
    code,
  }),
  200,
  `Manager MFA ${step}`,
);
if (session.staff?.role !== 'MANAGER' || !session.accessToken) {
  throw new Error('MFA did not return a manager session.');
}

const headers = { authorization: `Bearer ${session.accessToken}` };
const me = await responseJson(
  await fetch(`${baseUrl}/auth/staff/me`, { headers }),
  200,
  'Manager profile',
);
if (me.role !== 'MANAGER' || me.id !== session.staff.id) {
  throw new Error('The manager profile does not match the session.');
}
for (const [path, label] of [
  ['/dashboard/summary', 'Dashboard summary'],
  ['/staff-accounts', 'Staff accounts'],
  ['/tickets?status=RECEIVED', 'Manual triage queue'],
]) {
  await responseJson(await fetch(`${baseUrl}${path}`, { headers }), 200, label);
}

console.log(
  `Manager MFA ${step}, profile, dashboard, accounts, and triage queue passed.`,
);
