import { describe, expect, it } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { defineDocument, matchDocumentPattern } from '../src/documents.js';
import type { CollaborationConfig } from '../src/types.js';

describe('matchDocumentPattern', () => {
  it('extracts named params', () => {
    expect(matchDocumentPattern('researches/:id/writing', 'researches/42/writing')).toEqual({
      id: '42',
    });
  });

  it('rejects mismatches', () => {
    expect(matchDocumentPattern('researches/:id/writing', 'whiteboards/1')).toBeNull();
    expect(matchDocumentPattern('researches/:id/writing', 'researches/42/other')).toBeNull();
  });
});

describe('documents namespace', () => {
  const config = (overrides: Partial<CollaborationConfig> = {}): CollaborationConfig => ({
    engine: 'yjs',
    authorize: async () => ({ canRead: false, canWrite: false, canComment: false }),
    ...overrides,
  });

  it('resolves engine per declared document', async () => {
    const manager = new CollaborationManager(
      config({
        documents: {
          'researches/:id/writing': defineDocument({ engine: 'automerge' }),
        },
      }),
    );
    await expect(manager.engineFor({ docName: 'researches/1/writing' })).resolves.toBe('automerge');
    await expect(manager.engineFor({ docName: 'whiteboards/1' })).resolves.toBe('yjs');
  });

  it('passes the resolved docName and typed params to the declared authorize', async () => {
    const authorize = defineDocument<{ id: string }>({
      authorize: async (_ctx, { docName, params }) =>
        params.id === '42' && docName === 'researches/42/writing'
          ? { canRead: true, canWrite: true, canComment: true }
          : { canRead: false, canWrite: false, canComment: false },
    });
    const manager = new CollaborationManager(
      config({
        documents: { 'researches/:id/writing': authorize },
      }),
    );
    await expect(
      manager.getDocumentState({ docName: 'researches/42/writing' }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});
