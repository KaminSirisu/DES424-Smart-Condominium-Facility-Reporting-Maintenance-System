import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PhotoPurpose } from '../tickets/types.js';

/**
 * S3 access for uploaded images. The upload key encodes purpose and owner:
 *
 *   uploads/<purpose>/<ownerId>/<uploadId>
 *
 * so an object existing at that key proves the upload is of the expected
 * purpose and belongs to that owner — no separate metadata lookup needed.
 * POST /uploads writes to the same key: `createUploadGrant()` signs a PUT for
 * `uploadObjectKey()` and the server, not the client, picks the upload id.
 */

const s3 = new S3Client({ region: process.env.AWS_REGION });

/**
 * The client that signs upload URLs. A browser sends a plain PUT, so the SDK's
 * default CRC32 checksum (which would be signed into the URL for an empty
 * body) is turned off, or S3 would refuse every real upload.
 */
const uploadSigner = new S3Client({
  region: process.env.AWS_REGION,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

/** SR-20: JPEG, PNG or WebP, 10 MB at most. */
export const UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** SR-19: an upload URL expires within 5 minutes. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;

/** Upload IDs become part of an S3 key, so they must not contain `/` or other surprises. */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function uploadObjectKey(
  purpose: PhotoPurpose,
  ownerId: string,
  uploadId: string,
): string {
  return `uploads/${purpose}/${ownerId}/${uploadId}`;
}

function bucketName(): string {
  const name = process.env.UPLOAD_BUCKET_NAME;
  if (!name) {
    throw new Error('UPLOAD_BUCKET_NAME environment variable is not set.');
  }
  return name;
}

export interface UploadGrant {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  /** Headers the client must send with the PUT; the URL is signed with them. */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * A short-lived signed PUT URL for a new upload (SR-19). The key is made here
 * from a random id, never chosen by the client. The signature covers the
 * content type and the exact content length, so S3 itself refuses a file of
 * another type or size (SR-20, a presigned PUT has no size condition).
 */
export async function createUploadGrant(
  purpose: PhotoPurpose,
  ownerId: string,
  contentType: string,
  sizeBytes: number,
  now: Date = new Date(),
): Promise<UploadGrant> {
  const uploadId = randomUUID();
  const uploadUrl = await getSignedUrl(
    uploadSigner,
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: uploadObjectKey(purpose, ownerId, uploadId),
      ContentType: contentType,
      ContentLength: sizeBytes,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  );
  return {
    uploadId,
    uploadUrl,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    expiresAt: new Date(
      now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000,
    ).toISOString(),
  };
}

/**
 * True if the owner has completed an upload of this purpose with this ID and
 * it is not over the size limit (SR-20: the signed length already stops this,
 * the check is a second line).
 */
export async function uploadExists(
  purpose: PhotoPurpose,
  ownerId: string,
  uploadId: string,
): Promise<boolean> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: uploadObjectKey(purpose, ownerId, uploadId),
      }),
    );
    return !((head?.ContentLength ?? 0) > UPLOAD_MAX_BYTES);
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

export type ImageType = 'jpeg' | 'png' | 'webp';

/** How many bytes it takes to tell JPEG, PNG and WebP apart. */
const SIGNATURE_BYTES = 12;

/**
 * The image type a file really is, judged by its first bytes, or null. A file
 * name or a content type can be anything the uploader says; the bytes cannot
 * (SR-20 allows JPEG, PNG and WebP; SR-21 asks for this check).
 */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  const startsWith = (offset: number, values: number[]) =>
    values.every((value, i) => bytes[offset + i] === value);

  if (bytes.length >= 3 && startsWith(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    bytes.length >= 8 &&
    startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return 'png';
  }
  // WebP: "RIFF", four size bytes, then "WEBP"
  if (
    bytes.length >= SIGNATURE_BYTES &&
    startsWith(0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'webp';
  }
  return null;
}

/** The whole object's size from a ranged read's `Content-Range: bytes 0-11/<total>`. */
function totalSize(contentRange: string | undefined): number | null {
  const match = /\/(\d+)$/.exec(contentRange ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * True if the upload exists, is within the size limit and its first bytes are
 * a JPEG, PNG or WebP. Reads only the first bytes of the object.
 */
export async function uploadIsImage(
  purpose: PhotoPurpose,
  ownerId: string,
  uploadId: string,
): Promise<boolean> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: uploadObjectKey(purpose, ownerId, uploadId),
        Range: `bytes=0-${SIGNATURE_BYTES - 1}`,
      }),
    );
    if ((totalSize(result.ContentRange) ?? 0) > UPLOAD_MAX_BYTES) return false;
    const bytes = await result.Body?.transformToByteArray();
    return bytes !== undefined && detectImageType(bytes) !== null;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    // 404: no such object. 416: an empty object has no first bytes to read.
    if (e.name === 'NoSuchKey' || status === 404 || status === 416) {
      return false;
    }
    throw err;
  }
}
