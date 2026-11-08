import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const token = process.env.LINE_ID_TOKEN;
const [imagePath, location, description] = process.argv.slice(2);

if (!token || !imagePath || !location || !description) {
  console.error(
    'Set LINE_ID_TOKEN privately, then run: npm run test:smoke:intake -- <jpeg-path> <location> <description>',
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

async function createdJson(response, step) {
  const body = await response.text();
  if (response.status !== 201) {
    throw new Error(`${step} returned HTTP ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}

const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

const grant = await createdJson(
  await fetch(`${baseUrl}/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      purpose: 'DEFECT',
      contentType: 'image/jpeg',
      sizeBytes: image.length,
    }),
  }),
  'Upload grant',
);

if (!grant.uploadId || !grant.uploadUrl || grant.method !== 'PUT') {
  throw new Error('Upload grant is missing required fields.');
}

const put = await fetch(grant.uploadUrl, {
  method: 'PUT',
  headers: { ...grant.headers, 'Content-Length': String(image.length) },
  body: image,
});
if (!put.ok) {
  throw new Error(`S3 upload returned HTTP ${put.status}.`);
}

const ticket = await createdJson(
  await fetch(`${baseUrl}/tickets`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      location,
      description,
      defectPhotoUploadId: grant.uploadId,
    }),
  }),
  'Ticket creation',
);

if (!ticket.id || ticket.status !== 'RECEIVED') {
  throw new Error('Ticket response has no id or is not RECEIVED.');
}
console.log(`Created ticket ${ticket.id} with status ${ticket.status}.`);
