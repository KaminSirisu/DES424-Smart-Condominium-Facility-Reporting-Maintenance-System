const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const token = process.env.LINE_ID_TOKEN;

if (!token) {
  console.error(
    'Set a fresh LINE_ID_TOKEN privately, then run npm run test:smoke:reporter-upload.',
  );
  process.exit(2);
}

const intent = {
  purpose: 'DEFECT',
  contentType: 'image/jpeg',
  sizeBytes: 1024,
};
const url = `${baseUrl}/uploads`;

const unauthenticated = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(intent),
});
if (unauthenticated.status !== 401) {
  throw new Error(
    `Unauthenticated reporter upload returned HTTP ${unauthenticated.status}, expected 401.`,
  );
}

const response = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(intent),
});
const body = await response.json();
if (
  response.status !== 201 ||
  typeof body.uploadId !== 'string' ||
  typeof body.uploadUrl !== 'string' ||
  body.method !== 'PUT' ||
  body.headers?.['Content-Type'] !== 'image/jpeg'
) {
  throw new Error(
    `Reporter upload grant returned HTTP ${response.status}: ${body.error?.code ?? 'invalid grant'}.`,
  );
}

// The presigned URL is a credential. Never print it or the LINE token.
console.log('Reporter upload grant passed with a fresh LINE ID token.');
