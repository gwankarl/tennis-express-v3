import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

export const MAX_LISTING_IMAGE_FILE_BYTES = 8 * 1024 * 1024;
export const MIN_LISTING_IMAGE_SIDE = 320;
export const MAX_LISTING_IMAGE_SIDE = 8000;
export const MAX_LISTING_IMAGE_PIXELS = 40_000_000;
export const LISTING_IMAGE_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

export const ALLOWED_LISTING_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ListingImageMediaType = (typeof ALLOWED_LISTING_IMAGE_MEDIA_TYPES)[number];

export interface StagedListingImage {
  stageId: string;
  storageKey: string;
  mediaType: ListingImageMediaType;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

export class ListingImageUploadTooLargeError extends Error {
  constructor() {
    super('Listing image exceeds the allowed size.');
    this.name = 'ListingImageUploadTooLargeError';
  }
}

export class UnsupportedListingImageError extends Error {
  constructor() {
    super('Listing image is unsupported or invalid.');
    this.name = 'UnsupportedListingImageError';
  }
}

const SHARP_FORMATS: Record<ListingImageMediaType, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Stores normalized listing photos outside public web directories.
 * Client filenames and paths are never used as storage keys.
 */
export class PrivateListingImageFileStore {
  private readonly stagingDirectory: string;
  private readonly objectsDirectory: string;

  constructor(private readonly rootDirectory: string) {
    this.stagingDirectory = join(rootDirectory, '.staging');
    this.objectsDirectory = join(rootDirectory, 'objects');
  }

  async initialize(): Promise<void> {
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.objectsDirectory, { recursive: true, mode: 0o700 });
  }

  /**
   * Streams the untrusted upload to staging, checks its detected type and
   * decoded dimensions, and writes an immutable normalized copy.
   */
  async stage(source: Readable, declaredMediaType: string): Promise<StagedListingImage> {
    await this.initialize();

    const stageId = randomUUID();
    const storageKey = randomUUID();
    const uploadPath = this.uploadPath(stageId);
    const normalizedPath = this.normalizedPath(stageId);
    const prefixChunks: Buffer[] = [];
    let prefixBytes = 0;
    let inputByteSize = 0;

    const meter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        inputByteSize += bytes.byteLength;

        if (inputByteSize > MAX_LISTING_IMAGE_FILE_BYTES) {
          callback(new ListingImageUploadTooLargeError());
          return;
        }

        const prefixLength = Math.min(8192 - prefixBytes, bytes.byteLength);
        if (prefixLength > 0) {
          prefixChunks.push(bytes.subarray(0, prefixLength));
          prefixBytes += prefixLength;
        }

        callback(null, bytes);
      },
    });

    try {
      await pipeline(source, meter, createWriteStream(uploadPath, { flags: 'wx', mode: 0o600 }));

      if (inputByteSize === 0) {
        throw new UnsupportedListingImageError();
      }

      const { fileTypeFromBuffer } = await import('file-type');
      const detected = await fileTypeFromBuffer(Buffer.concat(prefixChunks));
      const normalizedDeclaredType = declaredMediaType.split(';', 1)[0]?.trim().toLowerCase();

      if (
        !detected ||
        !ALLOWED_LISTING_IMAGE_MEDIA_TYPES.includes(detected.mime as ListingImageMediaType) ||
        detected.mime !== normalizedDeclaredType
      ) {
        throw new UnsupportedListingImageError();
      }

      const mediaType = detected.mime as ListingImageMediaType;
      // Keep Sharp off the staging path so Windows does not retain a file
      // handle that prevents removing the raw upload after normalization.
      const sourceBytes = await readFile(uploadPath);
      const sourceImage = sharp(sourceBytes, {
        failOn: 'warning',
        limitInputPixels: MAX_LISTING_IMAGE_PIXELS,
      });

      let metadata: Awaited<ReturnType<typeof sourceImage.metadata>>;
      try {
        metadata = await sourceImage.metadata();
      } catch {
        throw new UnsupportedListingImageError();
      }

      const width = metadata.width;
      const height = metadata.height;

      if (
        metadata.format !== SHARP_FORMATS[mediaType] ||
        (metadata.pages ?? 1) !== 1 ||
        width === undefined ||
        height === undefined ||
        width < MIN_LISTING_IMAGE_SIDE ||
        height < MIN_LISTING_IMAGE_SIDE ||
        width > MAX_LISTING_IMAGE_SIDE ||
        height > MAX_LISTING_IMAGE_SIDE ||
        width * height > MAX_LISTING_IMAGE_PIXELS
      ) {
        throw new UnsupportedListingImageError();
      }

      let outputInfo: Awaited<ReturnType<ReturnType<typeof sharp>['toFile']>>;
      try {
        const normalized = sharp(sourceBytes, {
          failOn: 'warning',
          limitInputPixels: MAX_LISTING_IMAGE_PIXELS,
        }).rotate();

        switch (mediaType) {
          case 'image/jpeg':
            outputInfo = await normalized
              .jpeg({ quality: 88, mozjpeg: true })
              .toFile(normalizedPath);
            break;
          case 'image/png':
            outputInfo = await normalized.png({ compressionLevel: 9 }).toFile(normalizedPath);
            break;
          case 'image/webp':
            outputInfo = await normalized.webp({ quality: 85 }).toFile(normalizedPath);
            break;
        }
      } catch (error) {
        if (hasFilesystemErrorCode(error)) {
          throw error;
        }

        throw new UnsupportedListingImageError();
      }

      await chmod(normalizedPath, 0o600);

      const normalizedStats = await stat(normalizedPath);
      if (normalizedStats.size < 1) {
        throw new UnsupportedListingImageError();
      }
      if (normalizedStats.size > MAX_LISTING_IMAGE_FILE_BYTES) {
        throw new ListingImageUploadTooLargeError();
      }

      if (
        outputInfo.width < MIN_LISTING_IMAGE_SIDE ||
        outputInfo.height < MIN_LISTING_IMAGE_SIDE ||
        outputInfo.width > MAX_LISTING_IMAGE_SIDE ||
        outputInfo.height > MAX_LISTING_IMAGE_SIDE ||
        outputInfo.width * outputInfo.height > MAX_LISTING_IMAGE_PIXELS
      ) {
        throw new UnsupportedListingImageError();
      }

      const hash = createHash('sha256');
      for await (const chunk of createReadStream(normalizedPath)) {
        hash.update(chunk);
      }

      await rm(uploadPath, { force: true });

      return {
        stageId,
        storageKey,
        mediaType,
        byteSize: normalizedStats.size,
        width: outputInfo.width,
        height: outputInfo.height,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      await Promise.all([rm(uploadPath, { force: true }), rm(normalizedPath, { force: true })]);
      throw error;
    }
  }

  /** Moves a fully staged image into private object storage under its new key. */
  async promote(staged: StagedListingImage): Promise<void> {
    this.assertUuid(staged.stageId);
    this.assertUuid(staged.storageKey);
    await this.initialize();
    await rename(this.normalizedPath(staged.stageId), this.objectPath(staged.storageKey));
  }

  /** Removes staging files after a failed request or metadata write. */
  async discardStaged(staged: StagedListingImage): Promise<void> {
    this.assertUuid(staged.stageId);
    await Promise.all([
      rm(this.uploadPath(staged.stageId), { force: true }),
      rm(this.normalizedPath(staged.stageId), { force: true }),
    ]);
  }

  /** Opens an object for a route that has already authorized the image read. */
  openStored(storageKey: string): Readable {
    this.assertUuid(storageKey);
    return createReadStream(this.objectPath(storageKey));
  }

  /** Deletes one object; repeated cleanup is safe if it is already missing. */
  async deleteStored(storageKey: string): Promise<void> {
    this.assertUuid(storageKey);

    try {
      await unlink(this.objectPath(storageKey));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  /** Removes abandoned upload and normalized staging files after the grace period. */
  async cleanupAbandonedStaging(
    olderThanMs = LISTING_IMAGE_STAGING_RETENTION_MS,
    now = Date.now(),
  ): Promise<number> {
    await this.initialize();
    const entries = await readdir(this.stagingDirectory, { withFileTypes: true });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.(?:upload|normalized)$/iu.test(entry.name)) {
        continue;
      }

      const path = join(this.stagingDirectory, entry.name);
      const file = await stat(path);
      if (file.mtimeMs <= now - olderThanMs) {
        await rm(path, { force: true });
        removed += 1;
      }
    }

    return removed;
  }

  /** Removes old immutable objects not present in the database metadata set. */
  async cleanupOrphanedObjects(
    referencedStorageKeys: ReadonlySet<string>,
    olderThanMs = LISTING_IMAGE_STAGING_RETENTION_MS,
    now = Date.now(),
  ): Promise<number> {
    await this.initialize();
    const entries = await readdir(this.objectsDirectory, { withFileTypes: true });
    let removed = 0;

    for (const entry of entries) {
      const match = /^([0-9a-f-]{36})\.blob$/iu.exec(entry.name);
      if (!entry.isFile() || !match?.[1] || referencedStorageKeys.has(match[1])) {
        continue;
      }

      const path = join(this.objectsDirectory, entry.name);
      const file = await stat(path);
      if (file.mtimeMs <= now - olderThanMs) {
        await rm(path, { force: true });
        removed += 1;
      }
    }

    return removed;
  }

  /** Test helper for aging a staging file without waiting for the grace period. */
  async setModifiedTimeForCleanup(
    kind: 'staging' | 'object',
    key: string,
    modifiedAt: Date,
  ): Promise<void> {
    this.assertUuid(key);
    const path = kind === 'staging' ? this.normalizedPath(key) : this.objectPath(key);
    await utimes(path, modifiedAt, modifiedAt);
  }

  private uploadPath(stageId: string): string {
    return join(this.stagingDirectory, `${stageId}.upload`);
  }

  private normalizedPath(stageId: string): string {
    return join(this.stagingDirectory, `${stageId}.normalized`);
  }

  private objectPath(storageKey: string): string {
    return join(this.objectsDirectory, `${storageKey}.blob`);
  }

  private assertUuid(value: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      throw new Error('Invalid private listing image storage key.');
    }
  }
}

function hasFilesystemErrorCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(error.code)
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
