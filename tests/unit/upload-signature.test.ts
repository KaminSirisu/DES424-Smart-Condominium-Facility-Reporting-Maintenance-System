import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function S3Client() {
    return { send };
  }),
  HeadObjectCommand: vi.fn(function HeadObjectCommand(input: unknown) {
    return { name: 'Head', input };
  }),
  GetObjectCommand: vi.fn(function GetObjectCommand(input: unknown) {
    return { name: 'Get', input };
  }),
}));

import {
  detectImageType,
  uploadIsImage,
} from '../../backend/src/shared/upload-store';

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const HEIC = [
  0,
  0,
  0,
  0x18,
  ...[0x66, 0x74, 0x79, 0x70],
  0x68,
  0x65,
  0x69,
  0x63,
];
const text = (value: string) => [...Buffer.from(value)];

describe('detectImageType', () => {
  it.each([
    ['a JPEG', JPEG, 'jpeg'],
    ['a PNG', PNG, 'png'],
  ])('recognises %s', (_label, bytes, type) => {
    expect(detectImageType(Uint8Array.from(bytes))).toBe(type);
  });

  it.each([
    ['an empty file', []],
    ['plain text', text('hello, this is not an image')],
    ['an HTML page', text('<html><body>x</body></html>')],
    ['a PDF', text('%PDF-1.7 ...')],
    ['a GIF', text('GIF89a......')],
    ['a WebP, which Rekognition and LINE cannot read', WEBP],
    ['a HEIC photo, the iPhone default', HEIC],
    ['a RIFF file such as WAV', [...text('RIFF'), 0, 0, 0, 0, ...text('WAVE')]],
    ['a cut-off JPEG header', [0xff, 0xd8]],
    ['a cut-off PNG header', [0x89, 0x50, 0x4e, 0x47]],
  ])('rejects %s', (_label, bytes) => {
    expect(detectImageType(Uint8Array.from(bytes))).toBeNull();
  });
});

describe('uploadIsImage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('UPLOAD_BUCKET_NAME', 'test-bucket');
  });

  const body = (bytes: number[]) => ({
    Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
  });

  it('is true for an upload whose first bytes are an image, reading only the start', async () => {
    send.mockResolvedValue(body(JPEG));

    await expect(
      uploadIsImage('REPAIR_PROOF', 'acct_plumbing', 'upl_1'),
    ).resolves.toBe(true);

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'uploads/REPAIR_PROOF/acct_plumbing/upl_1',
      Range: 'bytes=0-7',
    });
  });

  it('is false for a file that is not an image', async () => {
    send.mockResolvedValue(body(text('not an image at all')));
    await expect(
      uploadIsImage('REPAIR_PROOF', 'acct_plumbing', 'upl_1'),
    ).resolves.toBe(false);
  });

  it.each([
    ['no such object', { name: 'NoSuchKey' }],
    ['a 404', { $metadata: { httpStatusCode: 404 } }],
    ['an empty object (416)', { $metadata: { httpStatusCode: 416 } }],
  ])('is false for %s', async (_label, failure) => {
    send.mockRejectedValue(Object.assign(new Error('s3'), failure));
    await expect(
      uploadIsImage('REPAIR_PROOF', 'acct_plumbing', 'upl_1'),
    ).resolves.toBe(false);
  });

  it('is false when the object has no body', async () => {
    send.mockResolvedValue({});
    await expect(
      uploadIsImage('REPAIR_PROOF', 'acct_plumbing', 'upl_1'),
    ).resolves.toBe(false);
  });

  it('rethrows other S3 failures so the caller can answer 500', async () => {
    send.mockRejectedValue(new Error('access denied'));
    await expect(
      uploadIsImage('REPAIR_PROOF', 'acct_plumbing', 'upl_1'),
    ).rejects.toThrow('access denied');
  });
});
