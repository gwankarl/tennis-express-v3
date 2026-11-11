import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_LISTING_IMAGE_MEDIA_TYPES,
  LISTING_IMAGE_STAGING_RETENTION_MS,
  ListingImageUploadTooLargeError,
  MAX_LISTING_IMAGE_FILE_BYTES,
  PrivateListingImageFileStore,
  UnsupportedListingImageError,
  type ListingImageMediaType,
} from '../../../../src/infrastructure/storage/private-listing-image-file-store.js';

let temporaryDirectory: string;
let store: PrivateListingImageFileStore;

async function makeImage(
  mediaType: ListingImageMediaType,
  width = 600,
  height = 400,
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 28, g: 120, b: 60 },
    },
  });

  switch (mediaType) {
    case 'image/jpeg':
      return image.jpeg().toBuffer();
    case 'image/png':
      return image.png().toBuffer();
    case 'image/webp':
      return image.webp().toBuffer();
  }
}

async function readStored(storageKey: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.openStored(storageKey)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-listing-images-'));
  store = new PrivateListingImageFileStore(temporaryDirectory);
  await store.initialize();
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('PrivateListingImageFileStore', () => {
  it.each(ALLOWED_LISTING_IMAGE_MEDIA_TYPES)(
    'detects, normalizes, promotes, and reads private %s content',
    async (mediaType) => {
      const input = await makeImage(mediaType);
      const staged = await store.stage(Readable.from([input]), mediaType);

      expect(staged).toMatchObject({
        mediaType,
        byteSize: expect.any(Number),
        width: 600,
        height: 400,
      });
      expect(staged.byteSize).toBeLessThanOrEqual(MAX_LISTING_IMAGE_FILE_BYTES);
      expect(staged.storageKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);

      await store.promote(staged);

      const bytes = await readStored(staged.storageKey);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.format).toBe(mediaType.split('/')[1]);
      expect(metadata.exif).toBeUndefined();
    },
  );

  it('normalizes EXIF orientation and strips the original metadata', async () => {
    const input = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 3,
        background: { r: 25, g: 90, b: 180 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const staged = await store.stage(Readable.from([input]), 'image/jpeg');

    expect(staged.width).toBe(400);
    expect(staged.height).toBe(600);

    await store.promote(staged);
    const metadata = await sharp(await readStored(staged.storageKey)).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it('rejects a declared MIME type that differs from the detected type', async () => {
    const input = await makeImage('image/png');

    await expect(store.stage(Readable.from([input]), 'image/jpeg')).rejects.toBeInstanceOf(
      UnsupportedListingImageError,
    );

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('rejects non-raster and malformed image content', async () => {
    await expect(
      store.stage(Readable.from([Buffer.from('<svg><script/></svg>')]), 'image/svg+xml'),
    ).rejects.toBeInstanceOf(UnsupportedListingImageError);

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('rejects images outside the approved dimensions', async () => {
    const tooSmall = await makeImage('image/jpeg', 319, 400);
    const tooWide = await makeImage('image/jpeg', 8001, 320);

    await expect(store.stage(Readable.from([tooSmall]), 'image/jpeg')).rejects.toBeInstanceOf(
      UnsupportedListingImageError,
    );
    await expect(store.stage(Readable.from([tooWide]), 'image/jpeg')).rejects.toBeInstanceOf(
      UnsupportedListingImageError,
    );

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('rejects bytes beyond the file limit while streaming and removes partial files', async () => {
    const source = Readable.from([
      Buffer.alloc(MAX_LISTING_IMAGE_FILE_BYTES, 0x41),
      Buffer.from([0x42]),
    ]);

    await expect(store.stage(source, 'image/jpeg')).rejects.toBeInstanceOf(
      ListingImageUploadTooLargeError,
    );

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('removes staging files after an interrupted upload', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('synthetic stream interruption'));
      },
    });

    await expect(store.stage(source, 'image/jpeg')).rejects.toThrow();
    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('uses fresh immutable object keys and makes deletion safe to retry', async () => {
    const input = await makeImage('image/webp');
    const first = await store.stage(Readable.from([input]), 'image/webp');
    const second = await store.stage(Readable.from([input]), 'image/webp');

    expect(first.storageKey).not.toBe(second.storageKey);

    await store.promote(first);
    await store.promote(second);

    const firstBytes = await readStored(first.storageKey);
    const secondBytes = await readStored(second.storageKey);
    expect(firstBytes).toEqual(secondBytes);

    await store.deleteStored(first.storageKey);
    await store.deleteStored(first.storageKey);
    await expect(
      readFile(join(temporaryDirectory, 'objects', `${first.storageKey}.blob`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await readStored(second.storageKey)).toEqual(secondBytes);
  });

  it('removes abandoned upload and normalized staging files after 24 hours', async () => {
    const input = await makeImage('image/png');
    const staged = await store.stage(Readable.from([input]), 'image/png');
    const now = Date.now();

    await store.setModifiedTimeForCleanup(
      'staging',
      staged.stageId,
      new Date(now - LISTING_IMAGE_STAGING_RETENTION_MS - 1),
    );

    expect(await store.cleanupAbandonedStaging(undefined, now)).toBe(1);
    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('removes only aged orphan objects and preserves referenced objects', async () => {
    const bytes = await makeImage('image/webp');
    const referenced = await store.stage(Readable.from([bytes]), 'image/webp');
    const orphan = await store.stage(Readable.from([bytes]), 'image/webp');

    await store.promote(referenced);
    await store.promote(orphan);

    const now = Date.now();
    await store.setModifiedTimeForCleanup(
      'object',
      orphan.storageKey,
      new Date(now - LISTING_IMAGE_STAGING_RETENTION_MS - 1),
    );

    const removed = await store.cleanupOrphanedObjects(
      new Set([referenced.storageKey]),
      LISTING_IMAGE_STAGING_RETENTION_MS,
      now,
    );

    expect(removed).toBe(1);
    expect((await readStored(referenced.storageKey)).length).toBeGreaterThan(0);
    await expect(
      readFile(join(temporaryDirectory, 'objects', `${orphan.storageKey}.blob`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
