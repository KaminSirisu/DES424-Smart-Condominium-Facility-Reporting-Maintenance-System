import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { TicketRecord } from '../../backend/src/tickets/types';

const { send, getSignedUrl } = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
}));
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
  PutObjectCommand: vi.fn(function PutObjectCommand(input: unknown) {
    return { name: 'Put', input };
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

import {
  PROOF_PHOTO_MAX_BYTES,
  makeThumbnail,
  photoAccess,
  proofPhotoTtlSeconds,
  proofPhotoUrl,
  thumbnailObjectKey,
} from '../../backend/src/shared/proof-photo';

/** A JPEG of random noise, which does not compress well, like a phone photo. */
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

const ORIGINAL_KEY = 'uploads/REPAIR_PROOF/acct_plumbing/proof_1';
const THUMBNAIL_KEY = 'thumbnails/REPAIR_PROOF/tkt_1/proof_1.jpg';

const ticket: TicketRecord = {
  id: 'tkt_1',
  location: 'Lobby',
  description: 'Water is leaking.',
  status: 'DONE',
  repairCycle: 1,
  photos: [
    {
      id: 'upl_1',
      purpose: 'DEFECT',
      addedAt: '2026-11-05T08:00:00.000Z',
      s3ObjectKey: 'uploads/DEFECT/Uabc123/upl_1',
    },
    {
      id: 'proof_1',
      purpose: 'REPAIR_PROOF',
      addedAt: '2026-11-05T11:00:00.000Z',
      repairCycle: 1,
      s3ObjectKey: ORIGINAL_KEY,
    },
  ],
  version: 6,
  reporterLineUserId: 'Uabc123',
  teamId: 'PLUMBING',
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-05T11:00:00.000Z',
};

const notFound = () =>
  Object.assign(new Error('missing'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });

/** Fake S3: `objects` holds what exists; Put adds to it. */
function fakeS3(objects: Map<string, Buffer>) {
  send.mockImplementation(
    async (command: { name: string; input: Record<string, unknown> }) => {
      const key = command.input.Key as string;
      if (command.name === 'Put') {
        objects.set(key, command.input.Body as Buffer);
        return {};
      }
      const object = objects.get(key);
      if (!object) throw notFound();
      if (command.name === 'Head') return {};
      return {
        ContentLength: object.length,
        Body: { transformToByteArray: async () => new Uint8Array(object) },
      };
    },
  );
}

describe('thumbnailObjectKey', () => {
  it('uses a separate prefix from the uploads', () => {
    expect(thumbnailObjectKey('tkt_1', 'proof_1')).toBe(THUMBNAIL_KEY);
  });

  it('names the purpose in the key, the repair proof by default', () => {
    expect(thumbnailObjectKey('tkt_1', 'upl_1', 'DEFECT')).toBe(
      'thumbnails/DEFECT/tkt_1/upl_1.jpg',
    );
  });
});

describe('proofPhotoTtlSeconds', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 15 minutes, the longest SR-23 allows', () => {
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '');
    expect(proofPhotoTtlSeconds()).toBe(900);
  });

  it('reads PROOF_PHOTO_URL_TTL_SECONDS', () => {
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '120');
    expect(proofPhotoTtlSeconds()).toBe(120);
  });

  it.each(['abc', '10', '1.5', '901', '3600', '604800', '-5'])(
    'rejects %s',
    (value) => {
      vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', value);
      expect(() => proofPhotoTtlSeconds()).toThrow(
        'PROOF_PHOTO_URL_TTL_SECONDS',
      );
    },
  );
});

describe('makeThumbnail', () => {
  it('shrinks a large photo to at most 1024 pixels and under the size limit', async () => {
    const original = await noisyJpeg(3000, 2000);
    expect(original.length).toBeGreaterThan(1_000_000);

    const thumbnail = await makeThumbnail(original);

    expect(thumbnail).not.toBeNull();
    const info = await sharp(thumbnail as Buffer).metadata();
    expect(info.format).toBe('jpeg');
    expect(info.width).toBe(1024);
    expect(info.height).toBe(683);
    expect((thumbnail as Buffer).length).toBeLessThanOrEqual(
      PROOF_PHOTO_MAX_BYTES,
    );
  });

  it('does not enlarge a small photo', async () => {
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

    const info = await sharp((await makeThumbnail(small)) as Buffer).metadata();

    expect(info.format).toBe('jpeg');
    expect([info.width, info.height]).toEqual([300, 200]);
  });

  it('turns a photo upright and drops its metadata', async () => {
    const sideways = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#aa3333' },
    })
      .withExif({ IFD0: { Copyright: 'someone' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const info = await sharp(
      (await makeThumbnail(sideways)) as Buffer,
    ).metadata();

    expect([info.width, info.height]).toEqual([100, 200]);
    expect(info.exif).toBeUndefined();
  });

  it('puts a transparent PNG on a white background', async () => {
    const transparent = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const { data } = await sharp((await makeThumbnail(transparent)) as Buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(data[0]).toBeGreaterThan(240);
  });

  it.each([
    ['text', Buffer.from('this is not an image')],
    ['an empty file', Buffer.alloc(0)],
    ['a cut-off JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
  ])('returns null for %s', async (_label, bytes) => {
    await expect(makeThumbnail(bytes)).resolves.toBeNull();
  });
});

describe('proofPhotoUrl', () => {
  let objects: Map<string, Buffer>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('UPLOAD_BUCKET_NAME', 'uploads-bucket');
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    objects = new Map();
    fakeS3(objects);
    getSignedUrl.mockResolvedValue('https://signed.example/photo?sig=1');
  });
  afterEach(() => vi.unstubAllEnvs());

  const commands = (name: string) =>
    send.mock.calls
      .map((call) => call[0])
      .filter((c: { name: string }) => c.name === name);

  it('makes the small copy once and signs a link to it', async () => {
    objects.set(ORIGINAL_KEY, await noisyJpeg(2400, 1600));

    const url = await proofPhotoUrl(ticket, 'proof_1');

    expect(url).toBe('https://signed.example/photo?sig=1');
    expect(commands('Put')).toHaveLength(1);
    expect(commands('Put')[0].input).toMatchObject({
      Bucket: 'uploads-bucket',
      Key: THUMBNAIL_KEY,
      ContentType: 'image/jpeg',
    });
    const stored = objects.get(THUMBNAIL_KEY) as Buffer;
    expect((await sharp(stored).metadata()).width).toBe(1024);
    // the original is left as it was
    expect((await sharp(objects.get(ORIGINAL_KEY)).metadata()).width).toBe(
      2400,
    );

    const [, command, options] = getSignedUrl.mock.calls[0];
    expect(command.input).toEqual({
      Bucket: 'uploads-bucket',
      Key: THUMBNAIL_KEY,
    });
    expect(options).toEqual({ expiresIn: 900 });
  });

  it('reuses an existing copy without reading the original', async () => {
    objects.set(THUMBNAIL_KEY, Buffer.from('already made'));

    await expect(proofPhotoUrl(ticket, 'proof_1')).resolves.toBe(
      'https://signed.example/photo?sig=1',
    );

    expect(commands('Get')).toHaveLength(0);
    expect(commands('Put')).toHaveLength(0);
  });

  it('signs with the configured lifetime', async () => {
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '600');
    objects.set(THUMBNAIL_KEY, Buffer.from('already made'));

    await proofPhotoUrl(ticket, 'proof_1');

    expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 600 });
  });

  it('returns null when the ticket has no such repair photo', async () => {
    await expect(proofPhotoUrl(ticket, 'upl_1')).resolves.toBeNull();
    await expect(proofPhotoUrl(ticket, 'nope')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns null when the original is gone', async () => {
    await expect(proofPhotoUrl(ticket, 'proof_1')).resolves.toBeNull();
    expect(commands('Put')).toHaveLength(0);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('returns null for a file that is not a readable image, and stores nothing', async () => {
    objects.set(ORIGINAL_KEY, Buffer.from('not an image at all'));

    await expect(proofPhotoUrl(ticket, 'proof_1')).resolves.toBeNull();

    expect(commands('Put')).toHaveLength(0);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('does not read an original that is far too large', async () => {
    send.mockImplementation(async (command: { name: string }) => {
      if (command.name === 'Head') throw notFound();
      return {
        ContentLength: 26 * 1024 * 1024,
        Body: {
          transformToByteArray: async () => {
            throw new Error('should not be read');
          },
        },
      };
    });

    await expect(proofPhotoUrl(ticket, 'proof_1')).resolves.toBeNull();
  });

  it('throws an S3 failure so the caller can decide', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('slow down'), { name: 'SlowDown' }),
    );
    await expect(proofPhotoUrl(ticket, 'proof_1')).rejects.toThrow('slow down');
  });

  it('needs the bucket name', async () => {
    vi.stubEnv('UPLOAD_BUCKET_NAME', '');
    await expect(proofPhotoUrl(ticket, 'proof_1')).rejects.toThrow(
      'UPLOAD_BUCKET_NAME',
    );
  });
});

describe('photoAccess', () => {
  const DEFECT_KEY = 'thumbnails/DEFECT/tkt_1/upl_1.jpg';
  const now = new Date('2026-11-06T08:00:00.000Z');
  let objects: Map<string, Buffer>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('UPLOAD_BUCKET_NAME', 'uploads-bucket');
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    objects = new Map();
    fakeS3(objects);
    getSignedUrl.mockResolvedValue('https://signed.example/photo?sig=1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('gives a link to a re-encoded copy of a defect photo, never to the original', async () => {
    objects.set('uploads/DEFECT/Uabc123/upl_1', await noisyJpeg(2400, 1600));

    const access = await photoAccess(ticket, 'upl_1', now);

    expect(access).toEqual({
      url: 'https://signed.example/photo?sig=1',
      expiresAt: '2026-11-06T08:15:00.000Z',
    });
    expect(getSignedUrl.mock.calls[0][1].input).toEqual({
      Bucket: 'uploads-bucket',
      Key: DEFECT_KEY,
    });
    expect(
      (await sharp(objects.get(DEFECT_KEY) as Buffer).metadata()).width,
    ).toBe(1024);
  });

  it('gives a link to the same copy of the repair proof that the LINE notice uses', async () => {
    objects.set(THUMBNAIL_KEY, Buffer.from('already made'));

    await expect(photoAccess(ticket, 'proof_1', now)).resolves.toMatchObject({
      url: 'https://signed.example/photo?sig=1',
    });
    expect(getSignedUrl.mock.calls[0][1].input.Key).toBe(THUMBNAIL_KEY);
  });

  it('reports the lifetime it signed with, at most 15 minutes', async () => {
    vi.stubEnv('PROOF_PHOTO_URL_TTL_SECONDS', '600');
    objects.set(DEFECT_KEY, Buffer.from('already made'));

    const access = await photoAccess(ticket, 'upl_1', now);

    expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 600 });
    expect(access?.expiresAt).toBe('2026-11-06T08:10:00.000Z');
  });

  it('returns null for a photo the ticket does not have', async () => {
    await expect(photoAccess(ticket, 'nope', now)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns null when the original is gone or is not an image', async () => {
    await expect(photoAccess(ticket, 'upl_1', now)).resolves.toBeNull();

    objects.set('uploads/DEFECT/Uabc123/upl_1', Buffer.from('not an image'));
    await expect(photoAccess(ticket, 'upl_1', now)).resolves.toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
