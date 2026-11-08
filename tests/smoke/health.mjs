import assert from 'node:assert/strict';

const baseUrl = process.argv[2];
const liffOrigin =
  process.argv[3] ?? 'https://main.d1zgqd6jel45cl.amplifyapp.com';

if (!baseUrl || new URL(baseUrl).protocol !== 'https:') {
  throw new Error('Pass the HTTPS API base URL, including /v1.');
}

const healthUrl = new URL(`${baseUrl.replace(/\/$/, '')}/health`);
const get = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
assert.equal(get.status, 200, `GET ${healthUrl} returned ${get.status}`);
assert.deepEqual(await get.json(), { status: 'ok' });

const preflight = await fetch(healthUrl, {
  method: 'OPTIONS',
  headers: {
    Origin: liffOrigin,
    'Access-Control-Request-Method': 'GET',
  },
  signal: AbortSignal.timeout(10_000),
});
assert.equal(
  preflight.status,
  204,
  `CORS preflight returned ${preflight.status}`,
);
assert.equal(preflight.headers.get('access-control-allow-origin'), liffOrigin);

console.log(`Health and LIFF CORS smoke checks passed: ${healthUrl}`);
