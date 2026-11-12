import { expect } from 'vitest';
import type { LucidStorage } from '../../src/storage/lucid_storage.js';
import type { CollabComment } from '../../src/types.js';

/** The storage API end to end: documents, versions (incl. prune) and comments. */
export async function exercise(storage: LucidStorage): Promise<void> {
  await storage.saveDocument('docs/a', new Uint8Array([1, 2]), { title: 'A' });
  await storage.saveDocument('docs/a', new Uint8Array([3]));
  expect((await storage.loadDocument('docs/a'))?.state).toEqual(new Uint8Array([3]));

  for (const seq of [1, 2, 3]) {
    await storage.saveVersion(
      'docs/a',
      {
        id: `v${seq}`,
        createdBy: 'user-1',
        label: null,
        seq,
        createdAt: new Date(2026, 0, seq).toISOString(),
      },
      new Uint8Array([seq]),
    );
  }
  expect((await storage.listVersions('docs/a', { page: 1, size: 2 })).map((v) => v.id)).toEqual([
    'v1',
    'v2',
  ]);
  expect(await storage.loadVersionSnapshot('docs/a', 'v2')).toEqual(new Uint8Array([2]));
  expect(await storage.pruneVersions({ keep: 1 })).toBe(2);

  await storage.saveComment('docs/a', comment('c1'));
  await storage.saveComment('docs/a', { ...comment('c1'), body: 'edited' });
  expect((await storage.getComment('docs/a', 'c1'))?.body).toBe('edited');
  expect(await storage.listComments('docs/a', 'text')).toHaveLength(1);
  await storage.deleteComment('docs/a', 'c1');
  expect(await storage.getComment('docs/a', 'c1')).toBeNull();
}

const comment = (id: string): CollabComment => ({
  id,
  documentName: 'docs/a',
  space: 'text',
  anchor: { kind: 'text-range', start: 0, end: 1, selectedText: 'a' },
  body: 'note',
  userId: 'user-1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
  updatedAt: null,
});
