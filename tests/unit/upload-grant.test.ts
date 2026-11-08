import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, getSignedUrl, clientConfigs } = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  clientConfigs: [] as unknown[],
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function S3Client(config: unknown) {
    clientConfigs.push(config);
    return { send };
  }),
  HeadObjectCommand: vi.fn(function HeadObjectCommand(input: unknown) {
    return { name: 'Head', input };
  }),
  GetObjectCommand: vi.fn(function GetObjectCommand(input: unknown) {
    return { name: 'Get', input };
  }),
  PutObjectCommand: vi.fn(function PutObjectCommand(input: unknown) {
    return { name: 'Put', input };
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

import {
  UPLOAD_ID_PATTERN,
  UPLOAD_MAX_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  createUploadGrant,
  uploadExists,
  uploadIsImage,
} from '../../backend/src/shared/upload-store';

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1,
]);
const object = (contentRange?: string) => ({
  ContentRange: contentRange,
  Body: { transformToByteArray: async () => JPEG },
});

describe('createUploadGrant', () => {
  beforeEach(() => {
    send.mockReset();
    getSignedUrl.mockReset();
    getSignedUrl.mockResolvedValue('https://bucket.example/signed');
    process.env.UPLOAD_BUCKET_NAME = 'photos';
  });

  it('signs a PUT of exactly this type and size for a key the server chose', async () => {
    const now = new Date('2026-11-06T08:00:00.000Z');
    const grant = await createUploadGrant(
      'REPAIR_PROOF',
      'plumbing@example.com',
      'image/png',
      4096,
      now,
    );

    expect(grant).toEqual({
      uploadId: expect.stringMatching(UPLOAD_ID_PATTERN),
      uploadUrl: 'https://bucket.example/signed',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: '2026-11-06T08:05:00.000Z',
    });

    const [, command, options] = getSignedUrl.mock.calls[0];
    expect(command.input).toEqual({
      Bucket: 'photos',
      Key: `uploads/REPAIR_PROOF/plumbing@example.com/${grant.uploadId}`,
      ContentType: 'image/png',
      ContentLength: 4096,
    });
    expect(options.expiresIn).toBe(UPLOAD_URL_TTL_SECONDS);
    expect(UPLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect([...options.signableHeaders].sort()).toEqual([
      'content-length',
      'content-type',
    ]);
  });

  it('makes a new id for every grant', async () => {
    const a = await createUploadGrant('DEFECT', 'Uaaa', 'image/jpeg', 10);
    const b = await createUploadGrant('DEFECT', 'Uaaa', 'image/jpeg', 10);
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it('signs with a client that leaves the SDK checksum off, which a browser PUT would not send', () => {
    expect(clientConfigs).toContainEqual(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
    );
  });

  it('fails clearly when the bucket name is not set', async () => {
    delete process.env.UPLOAD_BUCKET_NAME;
    await expect(
      createUploadGrant('DEFECT', 'Uaaa', 'image/jpeg', 10),
    ).rejects.toThrow('UPLOAD_BUCKET_NAME environment variable is not set.');
  });
});

describe('the size limit on an uploaded object (SR-20)', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.UPLOAD_BUCKET_NAME = 'photos';
  });

  it('accepts an upload of exactly the limit and refuses one above it', async () => {
    send.mockResolvedValueOnce({ ContentLength: UPLOAD_MAX_BYTES });
    await expect(uploadExists('DEFECT', 'Uaaa', 'upl_1')).resolves.toBe(true);

    send.mockResolvedValueOnce({ ContentLength: UPLOAD_MAX_BYTES + 1 });
    await expect(uploadExists('DEFECT', 'Uaaa', 'upl_1')).resolves.toBe(false);
  });

  it('reads the whole size of an object from a ranged read', async () => {
    send.mockResolvedValueOnce(object(`bytes 0-11/${UPLOAD_MAX_BYTES}`));
    await expect(uploadIsImage('REPAIR_PROOF', 'a', 'upl_1')).resolves.toBe(
      true,
    );

    send.mockResolvedValueOnce(object(`bytes 0-11/${UPLOAD_MAX_BYTES + 1}`));
    await expect(uploadIsImage('REPAIR_PROOF', 'a', 'upl_1')).resolves.toBe(
      false,
    );
  });

  it('does not refuse an object whose size is not reported', async () => {
    send.mockResolvedValueOnce(object(undefined));
    await expect(uploadIsImage('REPAIR_PROOF', 'a', 'upl_1')).resolves.toBe(
      true,
    );
  });
});
