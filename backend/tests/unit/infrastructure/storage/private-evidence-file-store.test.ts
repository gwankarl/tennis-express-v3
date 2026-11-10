import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceUploadTooLargeError,
  MAX_EVIDENCE_FILE_BYTES,
  PrivateEvidenceFileStore,
  UnsupportedEvidenceFileError,
} from '../../../../src/infrastructure/storage/private-evidence-file-store.js';

// Include the PNG signature and IHDR chunk type so file-type can identify it.
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let temporaryDirectory: string;
let store: PrivateEvidenceFileStore;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-evidence-'));
  store = new PrivateEvidenceFileStore(temporaryDirectory);
  await store.initialize();
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('PrivateEvidenceFileStore', () => {
  it('stages, detects, promotes, and reads a private PNG using an opaque key', async () => {
    const staged = await store.stage(Readable.from([pngBytes]), 'image/png');

    expect(staged.mediaType).toBe('image/png');
    expect(staged.byteSize).toBe(pngBytes.length);
    expect(staged.storageKey).not.toContain('/');
    expect(staged.storageKey).not.toContain('\\');
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);

    await store.promote(staged);

    const chunks: Buffer[] = [];
    for await (const chunk of store.openStored(staged.storageKey)) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks)).toEqual(pngBytes);
  });

  it('rejects content whose detected type does not match the declared type', async () => {
    await expect(store.stage(Readable.from([pngBytes]), 'application/pdf')).rejects.toBeInstanceOf(
      UnsupportedEvidenceFileError,
    );

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('rejects bytes beyond the limit while streaming and removes the partial file', async () => {
    const source = Readable.from([
      Buffer.alloc(MAX_EVIDENCE_FILE_BYTES, 0x41),
      Buffer.from([0x42]),
    ]);

    await expect(store.stage(source, 'image/png')).rejects.toBeInstanceOf(
      EvidenceUploadTooLargeError,
    );

    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('removes an interrupted upload from staging', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('synthetic stream interruption'));
      },
    });

    await expect(store.stage(source, 'image/png')).rejects.toThrow();
    expect(await readdir(join(temporaryDirectory, '.staging'))).toEqual([]);
  });

  it('cleans abandoned staging files and old unreferenced objects only', async () => {
    const staged = await store.stage(Readable.from([pngBytes]), 'image/png');
    const staleTime = new Date(Date.now() - 60_000);

    await store.setModifiedTimeForCleanup('staging', staged.stageId, staleTime);
    expect(await store.cleanupAbandonedStaging(1_000)).toBe(1);

    const second = await store.stage(Readable.from([pngBytes]), 'image/png');
    await store.promote(second);
    await store.setModifiedTimeForCleanup('object', second.storageKey, staleTime);

    expect(await store.cleanupOrphanedObjects(new Set([second.storageKey]), 1_000)).toBe(0);
    expect(await store.cleanupOrphanedObjects(new Set(), 1_000)).toBe(1);

    await expect(
      readFile(join(temporaryDirectory, 'objects', `${second.storageKey}.blob`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-UUID storage key before resolving a file path', async () => {
    expect(() => store.openStored('../outside-file')).toThrow('Invalid private storage key.');
  });
});
