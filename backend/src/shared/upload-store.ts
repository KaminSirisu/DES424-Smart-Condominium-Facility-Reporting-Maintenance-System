import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PhotoPurpose } from '../tickets/types.js';

/**
 * S3 access for uploaded images. The upload key encodes purpose and owner:
 *
 *   uploads/<purpose>/<ownerId>/<uploadId>
 *
 * so an object existing at that key proves the upload is of the expected
 * purpose and belongs to that owner — no separate metadata lookup needed.
 * The POST /uploads endpoint must write to the same key via
 * `uploadObjectKey()`.
 */

const s3 = new S3Client({ region: process.env.AWS_REGION });

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

/** True if the owner has completed an upload of this purpose with this ID. */
export async function uploadExists(
  purpose: PhotoPurpose,
  ownerId: string,
  uploadId: string,
): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: uploadObjectKey(purpose, ownerId, uploadId),
      }),
    );
    return true;
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

/**
 * True if the upload exists and its first bytes are a JPEG, PNG or WebP. Reads
 * only the first bytes of the object.
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
