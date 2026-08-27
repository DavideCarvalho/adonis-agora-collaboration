import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { FileSystemStorage } from '../src/storage/file_system_storage.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabVersion } from '../src/types.js';

/**
 * `pruneVersions` is the retention API — the thing that keeps the docs from
 * telling people to DELETE FROM collab_versions by hand. The contract that
 * matters is that `keep` is **per document**: a document versioned every
 * minute must never evict the history of one versioned twice a year.
 */
const version = (seq: number): CollabVersion => ({
  id: `v${seq}`,
  seq,
  createdAt: new Date(2026, 0, seq).toISOString(),
  createdBy: null,
  label: null,
});

async function seed(
  storage: InMemoryCollaborationStorage | FileSystemStorage,
  docName: string,
  count: number,
): Promise<void> {
  await storage.saveDocument(docName, new Uint8Array([1, 2, 3]));
  for (let seq = 1; seq <= count; seq++) {
    await storage.saveVersion(docName, version(seq), new Uint8Array([seq]));
  }
}

const seqs = async (storage: InMemoryCollaborationStorage, docName: string) =>
  (await storage.listVersions(docName)).map((entry) => entry.seq).sort((a, b) => a - b);

describe('InMemoryCollaborationStorage.pruneVersions', () => {
  it('keeps the N most recent versions of EACH document', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 6);
    await seed(storage, 'docs/quiet', 3);

    const removed = await storage.pruneVersions({ keep: 2 });

    // 4 from the busy document + 1 from the quiet one — never 7 (the count a
    // global "keep 2 rows" prune would delete).
    expect(removed).toBe(5);
    expect(await seqs(storage, 'docs/busy')).toEqual([5, 6]);
    expect(await seqs(storage, 'docs/quiet')).toEqual([2, 3]);
  });

  it('narrows to one document with docName', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 6);
    await seed(storage, 'docs/quiet', 3);

    const removed = await storage.pruneVersions({ keep: 1, docName: 'docs/busy' });

    expect(removed).toBe(5);
    expect(await seqs(storage, 'docs/busy')).toEqual([6]);
    expect(await seqs(storage, 'docs/quiet')).toEqual([1, 2, 3]);
  });

  it('deletes every version with keep: 0', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 4);

    expect(await storage.pruneVersions({ keep: 0 })).toBe(4);
    expect(await seqs(storage, 'docs/busy')).toEqual([]);
  });

  it('deletes nothing (and returns 0) when the history is shorter than keep', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/quiet', 2);

    expect(await storage.pruneVersions({ keep: 20 })).toBe(0);
    expect(await seqs(storage, 'docs/quiet')).toEqual([1, 2]);
  });

  it('counts without deleting on dryRun', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 6);

    expect(await storage.pruneVersions({ keep: 2, dryRun: true })).toBe(4);
    expect(await seqs(storage, 'docs/busy')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects a keep that is not a non-negative integer, instead of wiping history', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 4);

    for (const keep of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(storage.pruneVersions({ keep })).rejects.toThrow(
        /collaboration.*non-negative integer/,
      );
    }
    expect(await seqs(storage, 'docs/busy')).toEqual([1, 2, 3, 4]);
  });
});

describe('FileSystemStorage.pruneVersions', () => {
  let baseDir: string;

  beforeAll(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'collab-prune-fs-'));
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  /** Version files carry no seq on disk — recency is mtime, so pin it. */
  async function seedOnDisk(
    storage: FileSystemStorage,
    dir: string,
    docName: string,
    count: number,
  ): Promise<void> {
    await seed(storage, docName, count);
    for (let seq = 1; seq <= count; seq++) {
      const file = path.join(
        dir,
        'versions',
        `${encodeURIComponent(docName)}_${encodeURIComponent(`v${seq}`)}.bin`,
      );
      const when = new Date(2026, 0, seq);
      await utimes(file, when, when);
    }
  }

  const filesFor = async (dir: string, docName: string) =>
    (await readdir(path.join(dir, 'versions')))
      .filter((file) => file.startsWith(`${encodeURIComponent(docName)}_`))
      .sort();

  it('keeps the N most recent version files of EACH document', async () => {
    const dir = path.join(baseDir, 'per-document');
    const storage = new FileSystemStorage(dir);
    await seedOnDisk(storage, dir, 'busy', 5);
    await seedOnDisk(storage, dir, 'quiet', 3);

    expect(await storage.pruneVersions({ keep: 2 })).toBe(4);
    expect(await filesFor(dir, 'busy')).toEqual(['busy_v4.bin', 'busy_v5.bin']);
    expect(await filesFor(dir, 'quiet')).toEqual(['quiet_v2.bin', 'quiet_v3.bin']);
  });

  it('narrows to one document, and dryRun deletes nothing', async () => {
    const dir = path.join(baseDir, 'narrow');
    const storage = new FileSystemStorage(dir);
    await seedOnDisk(storage, dir, 'busy', 4);
    await seedOnDisk(storage, dir, 'quiet', 4);

    expect(await storage.pruneVersions({ keep: 1, docName: 'busy', dryRun: true })).toBe(3);
    expect(await filesFor(dir, 'busy')).toHaveLength(4);

    expect(await storage.pruneVersions({ keep: 1, docName: 'busy' })).toBe(3);
    expect(await filesFor(dir, 'busy')).toEqual(['busy_v4.bin']);
    expect(await filesFor(dir, 'quiet')).toHaveLength(4);
  });

  it('rejects an invalid keep before touching the disk', async () => {
    const dir = path.join(baseDir, 'invalid');
    const storage = new FileSystemStorage(dir);
    await seedOnDisk(storage, dir, 'busy', 3);

    await expect(storage.pruneVersions({ keep: -1 })).rejects.toThrow(/non-negative integer/);
    expect(await filesFor(dir, 'busy')).toHaveLength(3);
  });
});

describe('CollaborationManager.pruneVersions', () => {
  it('delegates to the configured storage and returns the deleted count', async () => {
    const storage = new InMemoryCollaborationStorage();
    await seed(storage, 'docs/busy', 5);
    const manager = new CollaborationManager({ engine: 'yjs', storage });

    expect(await manager.pruneVersions({ keep: 3, dryRun: true })).toBe(2);
    expect(await seqs(storage, 'docs/busy')).toEqual([1, 2, 3, 4, 5]);

    expect(await manager.pruneVersions({ keep: 3 })).toBe(2);
    expect(await seqs(storage, 'docs/busy')).toEqual([3, 4, 5]);

    await manager.close();
  });

  it('refuses to prune when no storage is configured', async () => {
    const manager = new CollaborationManager({ engine: 'yjs' });

    await expect(manager.pruneVersions({ keep: 5 })).rejects.toThrow(/requires a storage backend/);

    await manager.close();
  });
});
