import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LucidConnectionLike, LucidStorage } from '../../src/storage/lucid_storage.js';
import type { CollabComment } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `LucidStorage.saveDocument`/`saveComment` against a real Postgres.
 *
 * Both used to run a `SELECT ... first()` to decide insert-vs-update before writing — two
 * round-trips per save, on every debounce flush of every actively-edited document (the
 * yjs driver debounces every 2s; see `yjs_driver.ts`). They now emit a single
 * `insert(...).onConflict(...).merge(...)`, the same idiom `saveVersion` already used for
 * its own conflict handling. A real database is what can prove the emitted SQL is a valid
 * upsert on the ACTUAL unique constraint (the primary key both published migrations
 * declare) and that a second save updates rather than throwing a duplicate-key error.
 */
const SCHEMA = 'collab_upsert';

const baseComment = (): CollabComment => ({
  id: 'comment-1',
  documentName: 'docs/first',
  space: 'text',
  anchor: { kind: 'text-range', start: 0, end: 3, selectedText: 'abc' },
  body: 'first note',
  userId: 'user-1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
  updatedAt: null,
});

describe('LucidStorage upsert (Postgres)', () => {
  let integration: IntegrationDatabase;
  let storage: LucidStorage;

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
  });

  const rowCount = async (table: string) => {
    const result = await integration.db.rawQuery(`SELECT count(*)::int AS total FROM "${table}"`);
    return result.rows[0].total as number;
  };

  const documentRow = async (docName: string) => {
    const result = await integration.db.rawQuery(
      `SELECT * FROM "${SCHEMA}".collab_documents WHERE doc_name = ?`,
      [docName],
    );
    return result.rows[0] as
      | { created_at: Date; updated_at: Date; state: Buffer; meta: unknown }
      | undefined;
  };

  it('inserts a brand-new document on the first save', async () => {
    await storage.saveDocument('docs/new', new Uint8Array([1, 2, 3]));

    expect(await rowCount('collab_documents')).toBe(1);
    expect((await storage.loadDocument('docs/new'))?.state).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('updates an existing document in place, without touching created_at', async () => {
    await storage.saveDocument('docs/existing', new Uint8Array([1]));
    const first = await documentRow('docs/existing');

    // A real clock tick, so a bug that reset created_at would show up as equal
    // timestamps failing this assertion instead of passing by coincidence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await storage.saveDocument('docs/existing', new Uint8Array([9, 9]));
    const second = await documentRow('docs/existing');

    expect(await rowCount('collab_documents')).toBe(1);
    expect((await storage.loadDocument('docs/existing'))?.state).toEqual(new Uint8Array([9, 9]));
    expect(second!.created_at.getTime()).toBe(first!.created_at.getTime());
    expect(second!.updated_at.getTime()).toBeGreaterThan(first!.updated_at.getTime());
  });

  it('a repeated save of the same state is a no-op row-count-wise (idempotent upsert)', async () => {
    await storage.saveDocument('docs/idempotent', new Uint8Array([5]));
    await storage.saveDocument('docs/idempotent', new Uint8Array([5]));
    await storage.saveDocument('docs/idempotent', new Uint8Array([5]));

    expect(await rowCount('collab_documents')).toBe(1);
  });

  it('inserts a brand-new comment on the first save', async () => {
    await storage.saveComment('docs/first', baseComment());

    expect(await rowCount('collab_comments')).toBe(1);
    expect(await storage.getComment('docs/first', 'comment-1')).toMatchObject({
      body: 'first note',
      resolvedAt: null,
    });
  });

  it('updates an existing comment (resolve) instead of erroring on the primary key', async () => {
    await storage.saveComment('docs/first', baseComment());

    const resolved: CollabComment = {
      ...baseComment(),
      resolvedAt: new Date(2026, 0, 2).toISOString(),
      body: 'edited note',
    };
    await storage.saveComment('docs/first', resolved);

    expect(await rowCount('collab_comments')).toBe(1);
    const stored = await storage.getComment('docs/first', 'comment-1');
    expect(stored?.body).toBe('edited note');
    expect(stored?.resolvedAt).not.toBeNull();
  });
});

/**
 * Structural guard: the fix was replacing a `SELECT ... first()` + branch with one
 * `insert(...).onConflict(...).merge(...)` round-trip. A regex is brittle for behaviour,
 * but here it is exactly what the fix is — same technique `lucid_schema.spec.ts` already
 * uses to pin a source-level property this suite can't otherwise see (there is no faster
 * way to notice a regression back to the two-query shape than reading the source).
 */
describe('LucidStorage.saveDocument/saveComment emit a single upsert', () => {
  const source = async () =>
    readFile(fileURLToPath(new URL('../../src/storage/lucid_storage.ts', import.meta.url)), 'utf8');

  it('saveDocument has no SELECT-then-branch and upserts on doc_name', async () => {
    const text = await source();
    const start = text.indexOf('async saveDocument(');
    const end = text.indexOf('\n  }', start);
    const body = text.slice(start, end);

    expect(body).not.toMatch(/\.first\(\)/);
    expect(body).toMatch(/\.onConflict\(\s*'doc_name'\s*\)/);
    expect(body).toMatch(/\.merge\(/);
  });

  it('saveComment has no SELECT-then-branch and upserts on id', async () => {
    const text = await source();
    const start = text.indexOf('async saveComment(');
    const end = text.indexOf('\n  }', start);
    const body = text.slice(start, end);

    expect(body).not.toMatch(/\.first\(\)/);
    expect(body).toMatch(/\.onConflict\(\s*'id'\s*\)/);
    expect(body).toMatch(/\.merge\(/);
  });
});
