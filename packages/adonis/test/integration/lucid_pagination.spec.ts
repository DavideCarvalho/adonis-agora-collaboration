import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LucidConnectionLike, LucidStorage } from '../../src/storage/lucid_storage.js';
import type { CollabComment, CollabVersion } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `LucidStorage.listVersions`/`listComments` against a real Postgres, on the tables the
 * published migrations create.
 *
 * `lucid_prune.spec.ts` already proves the batched-delete SQL is valid; this file proves
 * the other half of the same class — that `.limit()`/`.offset()` land on the actual query
 * (not just get computed and dropped), that the result stays correctly ordered across
 * pages, and that an OMITTED page still returns the full history (what
 * `YjsDriver.createVersion`'s `seqVersions` and `restoreVersion`'s target lookup rely on).
 */
const SCHEMA = 'collab_pagination';

const version = (seq: number): CollabVersion => ({
  id: `v${seq}`,
  seq,
  createdAt: new Date(2026, 0, 1, 0, seq).toISOString(),
  createdBy: null,
  label: null,
});

const comment = (id: string, minute: number): CollabComment => ({
  id,
  documentName: 'docs/paged',
  space: 'text',
  anchor: { kind: 'timestamp', at: 0 },
  body: id,
  userId: 'u1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1, 0, minute).toISOString(),
  updatedAt: null,
});

describe('LucidStorage list pagination (Postgres)', () => {
  let integration: IntegrationDatabase;
  let storage: LucidStorage;
  const DOC = 'docs/paged';

  beforeAll(async () => {
    integration = await createIntegrationDatabase(SCHEMA);
    const { LucidStorage: RealLucidStorage } = await import('../../src/storage/lucid_storage.js');
    storage = new RealLucidStorage(integration.db as unknown as LucidConnectionLike);
  });

  afterAll(async () => {
    await integration?.teardown();
  });

  beforeEach(async () => {
    await integration.db.rawQuery(
      `TRUNCATE "${SCHEMA}".collab_versions, "${SCHEMA}".collab_documents, "${SCHEMA}".collab_comments`,
    );
    await storage.saveDocument(DOC, new Uint8Array([1]));
    for (let seq = 1; seq <= 10; seq++) {
      await storage.saveVersion(DOC, version(seq), new Uint8Array([seq]));
    }
    for (let minute = 1; minute <= 10; minute++) {
      await storage.saveComment(DOC, comment(`c${minute}`, minute));
    }
  });

  it('returns every row, oldest first, when no page is given', async () => {
    expect((await storage.listVersions(DOC)).map((v) => v.seq)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect((await storage.listComments(DOC)).map((c) => c.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `c${index + 1}`),
    );
  });

  it('limits and offsets versions server-side', async () => {
    expect((await storage.listVersions(DOC, { limit: 3, offset: 4 })).map((v) => v.seq)).toEqual([
      5, 6, 7,
    ]);
  });

  it('limits and offsets comments server-side, ordered by creation time', async () => {
    expect(
      (await storage.listComments(DOC, undefined, { limit: 3, offset: 4 })).map((c) => c.id),
    ).toEqual(['c5', 'c6', 'c7']);
  });

  it('two consecutive pages cover the whole history with no gap or overlap', async () => {
    const first = await storage.listVersions(DOC, { limit: 6, offset: 0 });
    const second = await storage.listVersions(DOC, { limit: 6, offset: 6 });
    expect([...first, ...second].map((v) => v.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('clamps an oversized limit and a negative offset rather than trusting the caller', async () => {
    expect(
      (await storage.listVersions(DOC, { limit: 999_999, offset: -100 })).map((v) => v.seq),
    ).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
  });

  it('narrows to a page and to a space at the same time', async () => {
    await storage.saveComment(DOC, {
      ...comment('canvas-1', 11),
      space: 'canvas',
    });

    const page = await storage.listComments(DOC, 'text', { limit: 2, offset: 0 });
    expect(page.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(page.every((c) => c.space === 'text')).toBe(true);
  });
});
