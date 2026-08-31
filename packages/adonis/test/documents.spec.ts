import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import {
  defineCollection,
  defineDocument,
  documentPatternParams,
  matchDocumentPattern,
} from '../src/documents.js';
import { setCollaborationLogger } from '../src/observability.js';
import type { CollaborationConfig } from '../src/types.js';

afterEach(() => {
  setCollaborationLogger(undefined);
});

const config = (overrides: Partial<CollaborationConfig> = {}): CollaborationConfig => ({
  engine: 'yjs',
  authorize: async () => ({ canRead: false, canWrite: false, canComment: false }),
  ...overrides,
});

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

describe('documentPatternParams', () => {
  it('lists the :segments in order, and none for a single-document pattern', () => {
    expect(documentPatternParams('workspaces/:workspaceId/boards/:boardId')).toEqual([
      'workspaceId',
      'boardId',
    ]);
    expect(documentPatternParams('announcements')).toEqual([]);
    // Only a segment that *starts* with ':' is a param — same rule as the matcher.
    expect(documentPatternParams('odd:name/:id')).toEqual(['id']);
  });
});

describe('defineCollection', () => {
  it('declares <prefix>/:id with the given declaration', () => {
    const declaration = { engine: 'automerge' as const };
    expect(defineCollection('whiteboards', declaration)).toEqual({
      'whiteboards/:id': declaration,
    });
    expect(defineCollection('announcements')).toEqual({ 'announcements/:id': {} });
  });

  it('accepts a nested literal prefix', () => {
    expect(Object.keys(defineCollection('workspaces/main/boards'))).toEqual([
      'workspaces/main/boards/:id',
    ]);
  });

  it('rejects a prefix that is not a plain literal', () => {
    for (const bad of ['', 'boards/:id', '/boards', 'boards/', 'a//b']) {
      expect(() => defineCollection(bad), bad).toThrow(/defineCollection/);
    }
  });

  it('is matched by the manager like a hand-written pattern', async () => {
    const manager = new CollaborationManager(
      config({
        documents: {
          ...defineCollection('whiteboards', { engine: 'automerge' }),
        },
      }),
    );
    await expect(manager.engineFor({ docName: 'whiteboards/7' })).resolves.toBe('automerge');
    await expect(manager.engineFor({ docName: 'whiteboards' })).resolves.toBe('yjs');
  });
});

describe('a pattern with no :segment is called out at boot', () => {
  it('warns once per single-document pattern, naming the fix', () => {
    const warn = vi.fn();
    setCollaborationLogger({ error: vi.fn(), warn });

    new CollaborationManager(
      config({
        documents: {
          whiteboards: { engine: 'automerge' },
          'researches/:id/writing': {},
          ...defineCollection('boards'),
        },
      }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [details, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(details).toEqual({ pattern: 'whiteboards' });
    expect(message).toContain('exactly one document named "whiteboards"');
    expect(message).toContain('"whiteboards/:id"');
    expect(message).toContain('defineCollection("whiteboards", …)');
  });

  it('stays quiet when every pattern has a :segment', () => {
    const warn = vi.fn();
    setCollaborationLogger({ error: vi.fn(), warn });
    new CollaborationManager(
      config({ documents: { 'researches/:id/writing': {}, ...defineCollection('boards') } }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to console.warn without a logger', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new CollaborationManager(config({ documents: { announcements: {} } }));
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(String(consoleWarn.mock.calls[0]?.[0])).toContain('announcements/:id');
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

describe('documents namespace', () => {
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
