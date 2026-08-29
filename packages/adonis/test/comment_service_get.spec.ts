import { describe, expect, it } from 'vitest';
import { CommentService } from '../src/services/comment_service.js';
import type { CollabComment, CollaborationStorage } from '../src/types.js';

/**
 * `CommentService` had no way to read ONE comment, so every caller that needed
 * one — the route guard above all — listed the document's comments and
 * filtered. `get()` is that read, and it hands the lookup to the storage when
 * the storage can index it (Lucid), instead of pulling every row.
 */

const comment = (id: string): CollabComment => ({
  id,
  documentName: 'docs/1',
  space: 'text',
  anchor: { kind: 'timestamp', at: 0 },
  body: id,
  userId: 'u1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: null,
});

function storage(options: { indexed: boolean }): CollaborationStorage & { calls: string[] } {
  const calls: string[] = [];
  const rows = [comment('a'), comment('b')];
  const base = {
    calls,
    async loadDocument() {
      return null;
    },
    async saveDocument() {},
    async listComments() {
      calls.push('listComments');
      return rows;
    },
    async saveComment() {},
    async deleteComment() {},
  } as unknown as CollaborationStorage & { calls: string[] };

  if (options.indexed) {
    base.getComment = async (_docName: string, commentId: string) => {
      calls.push(`getComment:${commentId}`);
      return rows.find((row) => row.id === commentId) ?? null;
    };
  }
  return base;
}

describe('CommentService.get', () => {
  it('asks the storage for the single row when it can index the lookup', async () => {
    const store = storage({ indexed: true });
    const service = new CommentService(store);

    expect((await service.get('docs/1', 'b'))?.id).toBe('b');
    expect(store.calls).toEqual(['getComment:b']);
  });

  it('falls back to a filtered list for a storage without the hook', async () => {
    const store = storage({ indexed: false });
    const service = new CommentService(store);

    expect((await service.get('docs/1', 'b'))?.id).toBe('b');
    expect(await service.get('docs/1', 'missing')).toBeNull();
    expect(store.calls).toEqual(['listComments', 'listComments']);
  });
});
