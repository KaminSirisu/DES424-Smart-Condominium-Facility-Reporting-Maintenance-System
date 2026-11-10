import sharp from 'sharp';

const baseUrl =
  process.env.API_BASE_URL ??
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1';
const token = process.env.LINE_ID_TOKEN;
const [ticketId] = process.argv.slice(2);

if (!token || !ticketId) {
  console.error(
    'Set a fresh LINE_ID_TOKEN from the original reporter, then run npm run test:smoke:photo-access -- <ticket-id>.',
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

const headers = { authorization: `Bearer ${token}` };
const ticket = await responseJson(
  await fetch(`${baseUrl}/tickets/${encodeURIComponent(ticketId)}`, {
    headers,
  }),
  200,
  'Reporter ticket detail',
);
const defect = ticket.photos?.find((photo) => photo.purpose === 'DEFECT');
if (!defect?.id) {
  throw new Error('The ticket has no defect photo to check.');
}

const accessUrl = `${baseUrl}/tickets/${encodeURIComponent(ticketId)}/photos/${encodeURIComponent(defect.id)}/access`;
const noAuth = await fetch(accessUrl);
if (noAuth.status !== 401) {
  throw new Error(
    `Unauthenticated photo access returned HTTP ${noAuth.status}, expected 401.`,
  );
}

const grant = await responseJson(
  await fetch(accessUrl, { headers }),
  200,
  'Reporter photo access',
);
if (typeof grant.url !== 'string' || !grant.expiresAt) {
  throw new Error('The photo access grant is incomplete.');
}
const signedUrl = new URL(grant.url);
if (
  signedUrl.protocol !== 'https:' ||
  !decodeURIComponent(signedUrl.pathname).includes('/thumbnails/DEFECT/')
) {
  throw new Error('The photo grant did not point to a JPEG thumbnail.');
}
const remainingMs = Date.parse(grant.expiresAt) - Date.now();
if (remainingMs <= 0 || remainingMs > 16 * 60 * 1000) {
  throw new Error('The photo grant has an invalid expiry time.');
}

// The signed URL is a credential; do not print it or the LINE token.
const imageResponse = await fetch(grant.url);
if (imageResponse.status !== 200) {
  throw new Error(`Signed photo GET returned HTTP ${imageResponse.status}.`);
}
const image = Buffer.from(await imageResponse.arrayBuffer());
const metadata = await sharp(image).metadata();
if (
  image.length > 900_000 ||
  metadata.format !== 'jpeg' ||
  !metadata.width ||
  !metadata.height ||
  metadata.width > 1024 ||
  metadata.height > 1024 ||
  metadata.exif
) {
  throw new Error('The returned photo is not a small EXIF-free JPEG.');
}

const missing = await fetch(
  `${baseUrl}/tickets/${encodeURIComponent(ticketId)}/photos/does-not-exist/access`,
  { headers },
);
if (missing.status !== 404) {
  throw new Error(
    `Missing photo returned HTTP ${missing.status}, expected 404.`,
  );
}

console.log(`Reporter photo access passed for ${ticketId}.`);
