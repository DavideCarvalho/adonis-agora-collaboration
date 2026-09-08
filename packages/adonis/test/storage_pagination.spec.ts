import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { FileSystemStorage } from '../src/storage/file_system_storage.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabComment, CollabVersion } from '../src/types.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

/**
 * `LucidStorage.listVersions`/`listComments` used to return every row for a
 * document, with no bound — a long-lived, frequently-versioned/commented doc
 * came back as one ever-growing JSON array over `GET /collaboration/versions`
 * and `/comments`. Pagination is opt-in on the storage interface (an absent
 * `page` still means "every row"), because internal callers computing the
 * next `seq` or a restore target need the whole history — only the HTTP
 * route always supplies one. `InMemoryCollaborationStorage` and
 * `FileSystemStorage` are the other two `CollaborationStorage` implementations
 * the interface promises this to; these tests hold them to the same contract
 * `LucidStorage` follows (see `test/integration/lucid_pagination.spec.ts` for
 * the real-Postgres half).
 */

const DOC = 'docs/pagination';

const version = (seq: number): CollabVersion => ({
  id: `v${seq}`,
  seq,
  createdAt: new Date(2026, 0, 1, 0, seq).toISOString(),
  createdBy: null,
  label: null,
});

const comment = (id: string, space: string, minute: number): CollabComment => ({
  id,
  documentName: DOC,
  space,
  anchor: { kind: 'timestamp', at: 0 },
  body: id,
  userId: 'u1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1, 0, minute).toISOString(),
  updatedAt: null,
});

describe('InMemoryCollaborationStorage pagination', () => {
  it('returns every version when no page is given', async () => {
    const storage = new InMemoryCollaborationStorage();
    for (let seq = 1; seq <= 5; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([seq]));
    }

    expect((await storage.listVersions(DOC)).map((v) => v.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('slices to the requested 1-based page/size', async () => {
    const storage = new InMemoryCollaborationStorage();
    for (let seq = 1; seq <= 5; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([seq]));
    }

    // page 2 of size 2 is `(2 - 1) * 2 = 2` rows in — the 0-based offset is the
    // store's business, never the caller's.
    expect((await storage.listVersions(DOC, { page: 2, size: 2 })).map((v) => v.seq)).toEqual([
      3, 4,
    ]);
    expect((await storage.listVersions(DOC, { page: 1, size: 2 })).map((v) => v.seq)).toEqual([
      1, 2,
    ]);
  });

  it('treats an omitted page as the first one', async () => {
    const storage = new InMemoryCollaborationStorage();
    for (let seq = 1; seq <= 5; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([seq]));
    }

    expect((await storage.listVersions(DOC, { size: 2 })).map((v) => v.seq)).toEqual([1, 2]);
  });

  it('clamps an oversized size and a page below one', async () => {
    const storage = new InMemoryCollaborationStorage();
    for (let seq = 1; seq <= 5; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([seq]));
    }

    expect(
      (await storage.listVersions(DOC, { page: -3, size: 999_999 })).map((v) => v.seq),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('paginates comments after filtering by space', async () => {
    const storage = new InMemoryCollaborationStorage();
    await storage.saveComment(DOC, comment('a', 'text', 1));
    await storage.saveComment(DOC, comment('b', 'canvas', 2));
    await storage.saveComment(DOC, comment('c', 'text', 3));
    await storage.saveComment(DOC, comment('d', 'text', 4));

    // Space filter first, then the page — `b` is a canvas comment and must not
    // occupy a slot on the text thread's first page.
    const first = await storage.listComments(DOC, 'text', { page: 1, size: 2 });
    const second = await storage.listComments(DOC, 'text', { page: 2, size: 2 });
    expect(first.map((c) => c.id)).toEqual(['a', 'c']);
    expect(second.map((c) => c.id)).toEqual(['d']);
  });

  it('does not truncate the history a live driver uses to compute the next seq', async () => {
    // Regression guard: `listVersions` without a `page` must still return every
    // version, or `seqVersions(existing)` inside `YjsDriver.createVersion` would
    // compute the max over a 50-row default page instead of the real history —
    // silently duplicating `seq` numbers past the default page size.
    const storage = new InMemoryCollaborationStorage();
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'seed');
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));
    for (let seq = 1; seq <= 60; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([1]));
    }

    const driver = new YjsDriver({
      authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
    });
    const created = await driver.createVersion(DOC, 'u1', 'sixty-first');
    expect(created.seq).toBe(61);
    await driver.close();
  });
});

describe('FileSystemStorage pagination', () => {
  it('paginates comments the same way as the in-memory store', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'collab-fs-pagination-'));
    try {
      const storage = new FileSystemStorage(baseDir);
      await storage.saveComment(DOC, comment('a', 'text', 1));
      await storage.saveComment(DOC, comment('b', 'text', 2));
      await storage.saveComment(DOC, comment('c', 'text', 3));

      expect((await storage.listComments(DOC)).map((c) => c.id)).toEqual(['a', 'b', 'c']);
      expect(
        (await storage.listComments(DOC, undefined, { page: 2, size: 1 })).map((c) => c.id),
      ).toEqual(['b']);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
