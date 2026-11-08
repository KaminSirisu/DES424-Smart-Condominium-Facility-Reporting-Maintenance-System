import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import type {
  PhotoPurpose,
  StoredTicketPhoto,
  TicketRecord,
} from '../tickets/types.js';

/**
 * A ticket photo as a person sees it: the repair proof in the LINE completion
 * notice (SCFRMS-43) and any photo behind GET .../photos/{photoId}/access.
 *
 * LINE shows an image in a Flex Message only when it is an HTTPS JPEG or PNG
 * of at most 1024 by 1024 pixels and about 1 MB, and a phone photo is far
 * bigger. So the original stays untouched in S3 as the record, and a small
 * JPEG copy is made under a separate prefix:
 *
 *   thumbnails/<purpose>/<ticketId>/<photoId>.jpg
 *
 * The copy is made once and reused (a retry or the next reporter finds it),
 * and a short-lived signed read URL for it goes into the message or the access
 * response. The copy is re-encoded, which also drops the photo's EXIF data
 * such as GPS position (SR-22): nobody is given a link to the original.
 *
 * Environment: UPLOAD_BUCKET_NAME (the same bucket as the uploads) and
 * PROOF_PHOTO_URL_TTL_SECONDS (default 900; 60 to 900, because SR-23 allows
 * a signed photo URL to live 15 minutes at most).
 */

const s3 = new S3Client({ region: process.env.AWS_REGION });

export const PROOF_PHOTO_MAX_PIXELS = 1024;
/** LINE accepts about 1 MB; stay safely under it. */
export const PROOF_PHOTO_MAX_BYTES = 900_000;
/** Originals above this are not resized, to keep the worker's memory bounded. */
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const JPEG_QUALITIES = [80, 65, 50, 35];

const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 15 * 60;

export function thumbnailObjectKey(
  ticketId: string,
  photoId: string,
  purpose: PhotoPurpose = 'REPAIR_PROOF',
): string {
  return `thumbnails/${purpose}/${ticketId}/${photoId}.jpg`;
}

function bucketName(): string {
  const name = process.env.UPLOAD_BUCKET_NAME;
  if (!name) {
    throw new Error('UPLOAD_BUCKET_NAME environment variable is not set.');
  }
  return name;
}

/** How long a signed photo link works, from PROOF_PHOTO_URL_TTL_SECONDS. */
export function proofPhotoTtlSeconds(): number {
  const raw = process.env.PROOF_PHOTO_URL_TTL_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_TTL_SECONDS ||
    value > MAX_TTL_SECONDS
  ) {
    throw new Error(
      `PROOF_PHOTO_URL_TTL_SECONDS must be a whole number from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}.`,
    );
  }
  return value;
}

/**
 * A JPEG of at most 1024 pixels on its longest side and under
 * PROOF_PHOTO_MAX_BYTES, turned upright by its EXIF orientation, or null when
 * the bytes are not an image sharp can read or it cannot be made small enough.
 */
export async function makeThumbnail(
  original: Uint8Array,
): Promise<Buffer | null> {
  try {
    for (const quality of JPEG_QUALITIES) {
      const output = await sharp(original, { failOn: 'error' })
        .rotate()
        .resize({
          width: PROOF_PHOTO_MAX_PIXELS,
          height: PROOF_PHOTO_MAX_PIXELS,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer();
      if (output.length <= PROOF_PHOTO_MAX_BYTES) return output;
    }
    return null;
  } catch {
    return null;
  }
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function readOriginal(key: string): Promise<Uint8Array | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    );
    if ((result.ContentLength ?? 0) > MAX_ORIGINAL_BYTES) return null;
    return (await result.Body?.transformToByteArray()) ?? null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * A short-lived signed https URL of the small copy of a ticket photo, making
 * the copy first when it does not exist yet. Null when the original is gone or
 * cannot be turned into a small image; S3 failures are thrown.
 */
async function copyUrl(
  ticket: TicketRecord,
  photo: StoredTicketPhoto,
): Promise<string | null> {
  const key = thumbnailObjectKey(ticket.id, photo.id, photo.purpose);
  if (!(await objectExists(key))) {
    const original = await readOriginal(photo.s3ObjectKey);
    if (!original) return null;
    const thumbnail = await makeThumbnail(original);
    if (!thumbnail) {
      console.error('Ticket photo could not be made small enough', {
        ticketId: ticket.id,
        photoId: photo.id,
      });
      return null;
    }
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: key,
        Body: thumbnail,
        ContentType: 'image/jpeg',
      }),
    );
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    { expiresIn: proofPhotoTtlSeconds() },
  );
}

/**
 * The link for the LINE completion notice: the small copy of the ticket's
 * repair proof photo. Null when the ticket has no such photo or the file cannot
 * be turned into a small image.
 */
export async function proofPhotoUrl(
  ticket: TicketRecord,
  photoId: string,
): Promise<string | null> {
  const photo = ticket.photos.find(
    (p) => p.purpose === 'REPAIR_PROOF' && p.id === photoId,
  );
  return photo ? copyUrl(ticket, photo) : null;
}

export interface PhotoAccess {
  url: string;
  expiresAt: string;
}

/**
 * The read grant of GET .../photos/{photoId}/access for a photo of any purpose
 * on the ticket. Null when the ticket has no such photo or it cannot be made
 * viewable. The caller must have checked the caller's right to the ticket.
 */
export async function photoAccess(
  ticket: TicketRecord,
  photoId: string,
  now: Date = new Date(),
): Promise<PhotoAccess | null> {
  const photo = ticket.photos.find((p) => p.id === photoId);
  if (!photo) return null;
  const url = await copyUrl(ticket, photo);
  if (!url) return null;
  return {
    url,
    expiresAt: new Date(
      now.getTime() + proofPhotoTtlSeconds() * 1000,
    ).toISOString(),
  };
}
