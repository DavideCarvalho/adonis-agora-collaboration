import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LucidConnectionLike, LucidStorage } from '../../src/storage/lucid_storage.js';
import type { CollabVersion } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `LucidStorage.pruneVersions` against a real Postgres, on the tables the published
 * migrations create.
 *
 * The unit suite can prove the *selection* rule (keep N per document); only a database can
 * prove the statements the storage emits are valid SQL, that the batched `whereIn` loop
 * deletes what it says, and that the delete counts Postgres returns are the number the
 * caller (and the ace command) reports.
 */
const SCHEMA = 'collab_prune';

const version = (seq: number): CollabVersion => ({
  id: `v${seq}`,
  seq,
  createdAt: new Date(2026, 0, 1, 0, seq).toISOString(),
  createdBy: null,
  label: null,
});

describe('LucidStorage.pruneVersions (Postgres)', () => {
  let integration: IntegrationDatabase;
  let storage: LucidStorage;

  beforeAll(async () => {
    integration = await createIntegrationDatabase(SCHEMA);
    // Imported after the harness primed the app service: the storage module loads the
    // Lucid db facade at module scope. This is the real class, not a copy.
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
  });

  const seed = async (docName: string, count: number) => {
    await storage.saveDocument(docName, new Uint8Array([1, 2, 3]));
    for (let seq = 1; seq <= count; seq++) {
      await storage.saveVersion(docName, version(seq), new Uint8Array([seq, seq]));
    }
  };

  const seqs = async (docName: string) =>
    (await storage.listVersions(docName)).map((entry) => entry.seq);

  const rowCount = async (table: string) => {
    const result = await integration.db.rawQuery(`SELECT count(*)::int AS total FROM "${table}"`);
    return result.rows[0].total as number;
  };

  it('keeps the N most recent versions of EACH document', async () => {
    await seed('docs/busy', 6);
    await seed('docs/quiet', 3);

    const removed = await storage.pruneVersions({ keep: 2 });

    // 4 from the busy document + 1 from the quiet one. A prune that kept 2 rows
    // globally would have deleted 7 and emptied the quiet document's history.
    expect(removed).toBe(5);
    expect(await seqs('docs/busy')).toEqual([5, 6]);
    expect(await seqs('docs/quiet')).toEqual([2, 3]);
    expect(await rowCount('collab_versions')).toBe(4);
  });

  it('narrows to a single document with docName', async () => {
    await seed('docs/busy', 5);
    await seed('docs/quiet', 4);

    expect(await storage.pruneVersions({ keep: 1, docName: 'docs/busy' })).toBe(4);
    expect(await seqs('docs/busy')).toEqual([5]);
    expect(await seqs('docs/quiet')).toEqual([1, 2, 3, 4]);
  });

  it('deletes every version with keep: 0, and leaves documents and comments alone', async () => {
    await seed('docs/busy', 4);
    await storage.saveComment('docs/busy', {
      id: 'comment-1',
      documentName: 'docs/busy',
      space: 'text',
      anchor: { kind: 'text-range', start: 0, end: 4, selectedText: 'word' },
      body: 'a note',
      userId: 'user-1',
      authorName: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });

    expect(await storage.pruneVersions({ keep: 0 })).toBe(4);
    expect(await seqs('docs/busy')).toEqual([]);
    expect(await rowCount('collab_documents')).toBe(1);
    expect(await rowCount('collab_comments')).toBe(1);
    expect(await storage.loadDocument('docs/busy')).not.toBeNull();
  });

  it('counts without deleting on dryRun', async () => {
    await seed('docs/busy', 6);

    expect(await storage.pruneVersions({ keep: 2, dryRun: true })).toBe(4);
    expect(await rowCount('collab_versions')).toBe(6);
    expect(await seqs('docs/busy')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects an invalid keep before deleting anything', async () => {
    await seed('docs/busy', 4);

    for (const keep of [-1, 2.5, Number.NaN]) {
      await expect(storage.pruneVersions({ keep })).rejects.toThrow(
        /collaboration.*non-negative integer/,
      );
    }
    expect(await rowCount('collab_versions')).toBe(4);
  });

  it('keeps the surviving snapshots byte-for-byte restorable', async () => {
    await seed('docs/busy', 5);

    await storage.pruneVersions({ keep: 2 });

    expect(await storage.loadVersionSnapshot('docs/busy', 'v5')).toEqual(new Uint8Array([5, 5]));
    expect(await storage.loadVersionSnapshot('docs/busy', 'v4')).toEqual(new Uint8Array([4, 4]));
    // A pruned version is gone, not a row with a null snapshot silently falling back to
    // the live document.
    expect(await storage.listVersions('docs/busy')).toHaveLength(2);
  });

  it('deletes a history longer than one batch', async () => {
    // PRUNE_BATCH_SIZE is 500 — 1200 versions exercises the batched IN (...) loop, and a
    // batch that mis-scoped its document would show up as a wrong count here.
    await storage.saveDocument('docs/huge', new Uint8Array([1]));
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      doc_name: 'docs/huge',
      id: `v${index + 1}`,
      created_by: null,
      label: null,
      seq: index + 1,
      snapshot: Buffer.from([1]),
      created_at: new Date(),
    }));
    await integration.db.table('collab_versions').multiInsert(rows);
    await seed('docs/quiet', 3);

    expect(await storage.pruneVersions({ keep: 5 })).toBe(1195);
    expect(await seqs('docs/huge')).toEqual([1196, 1197, 1198, 1199, 1200]);
    expect(await seqs('docs/quiet')).toEqual([1, 2, 3]);
  });
});

/**
 * Two regressions the unit suite structurally could not see, both found by running the
 * storage against the schema the published migrations create.
 */
describe('LucidStorage on the published migration schema', () => {
  let integration: IntegrationDatabase;
  let storage: LucidStorage;

  beforeAll(async () => {
    integration = await createIntegrationDatabase('collab_published_schema');
    const { LucidStorage: RealLucidStorage } = await import('../../src/storage/lucid_storage.js');
    // A fresh instance: its lazy `ensureSchema` has not run yet, which is where the
    // "relation collab_comments_doc_name_space_index already exists" failure lived.
    storage = new RealLucidStorage(integration.db as unknown as LucidConnectionLike);
  });

  afterAll(async () => {
    await integration?.teardown();
  });

  it('writes a document, a version and a comment on the migrated tables', async () => {
    await storage.saveDocument('docs/first', new Uint8Array([9, 8, 7]));
    await storage.saveVersion('docs/first', version(1), new Uint8Array([9]));
    await storage.saveComment('docs/first', {
      id: 'comment-1',
      documentName: 'docs/first',
      space: 'text',
      anchor: { kind: 'text-range', start: 0, end: 3, selectedText: 'abc' },
      body: 'first note',
      userId: 'user-1',
      authorName: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });

    expect((await storage.loadDocument('docs/first'))?.state).toEqual(new Uint8Array([9, 8, 7]));
    expect(await storage.listVersions('docs/first')).toHaveLength(1);
    expect(await storage.listComments('docs/first')).toHaveLength(1);

    // The upsert path: a second save of the same document and comment updates instead of
    // violating the primary key.
    await storage.saveDocument('docs/first', new Uint8Array([1]));
    expect((await storage.loadDocument('docs/first'))?.state).toEqual(new Uint8Array([1]));
    expect(await storage.pruneVersions({ keep: 0, docName: 'docs/first' })).toBe(1);
  });
});
