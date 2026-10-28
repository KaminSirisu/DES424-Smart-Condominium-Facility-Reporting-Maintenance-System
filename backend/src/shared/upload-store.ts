import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PhotoPurpose } from '../tickets/types';

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
