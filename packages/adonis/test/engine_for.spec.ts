import { describe, expect, it, vi } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollaborationConfig } from '../src/types.js';

function config(overrides?: Partial<CollaborationConfig>): CollaborationConfig {
  return {
    engine: 'yjs',
    authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
    ...overrides,
  };
}

describe('engineFor', () => {
  it('resolves the engine per document', async () => {
    const manager = new CollaborationManager(
      config({ engineFor: (doc) => (doc.startsWith('lousas/') ? 'automerge' : 'yjs') }),
    );
    await expect(manager.engineFor('lousas/1')).resolves.toBe('automerge');
    await expect(manager.engineFor('researches/1')).resolves.toBe('yjs');
  });

  it('defaults to config.engine without a resolver', async () => {
    const manager = new CollaborationManager(config());
    await expect(manager.engineFor('anything')).resolves.toBe('yjs');
  });

  it('materializes the driver of the resolved engine lazily', async () => {
    const manager = new CollaborationManager(
      config({ engineFor: (doc) => (doc.startsWith('lousas/') ? 'automerge' : 'yjs') }),
    );
    const drivers = (manager as unknown as { drivers: Map<string, unknown> }).drivers;

    // Default engine eager; automerge only after a lousas doc is touched.
    expect(drivers.has('automerge')).toBe(false);
    await manager.getDocumentState('lousas/1');
    expect(drivers.has('automerge')).toBe(true);
    expect(drivers.has('yjs')).toBe(true);
  });
});
