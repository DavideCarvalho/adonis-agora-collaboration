import { describe, expect, it } from 'vitest';
import CollaborationServiceProvider from '../providers/collaboration_provider.js';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollaborationAppConfig } from '../src/define_config.js';
import { defineDocument } from '../src/documents.js';

/**
 * The provider is the only thing that turns `config/collaboration.ts` into a
 * manager. Everything the config declares has to survive that translation —
 * a declaration the provider silently drops looks configured and behaves as
 * if it were never written.
 */
function buildManager(config: CollaborationAppConfig): CollaborationManager {
  let factory: (() => CollaborationManager) | undefined;
  const app = {
    config: { get: () => config },
    container: {
      singleton(_binding: unknown, resolver: () => CollaborationManager) {
        factory = resolver;
      },
    },
  };

  new CollaborationServiceProvider(app as never).register();
  if (!factory) throw new Error('the provider did not bind CollaborationManager');
  return factory();
}

describe('provider → manager wiring', () => {
  it('forwards declared documents, so their engine applies', async () => {
    const manager = buildManager({
      engine: 'yjs',
      documents: { 'whiteboards/:id': defineDocument({ engine: 'automerge' }) },
    });

    await expect(manager.engineFor({ docName: 'whiteboards/7' })).resolves.toBe('automerge');
    await expect(manager.engineFor({ docName: 'researches/7/writing' })).resolves.toBe('yjs');
  });

  it('forwards declared documents, so their authorize applies', async () => {
    const manager = buildManager({
      engine: 'yjs',
      documents: {
        'researches/:id/writing': defineDocument<{ id: string }>({
          authorize: async (ctx, { params }) => ({
            canRead: params.id === ctx.userId,
            canWrite: false,
            canComment: false,
          }),
        }),
      },
    });

    await expect(
      manager.authorize({ userId: '42' }, 'researches/42/writing'),
    ).resolves.toMatchObject({ canRead: true });
    await expect(
      manager.authorize({ userId: '42' }, 'researches/99/writing'),
    ).resolves.toMatchObject({ canRead: false });
  });

  it('fails closed for a document no rule matches', async () => {
    const manager = buildManager({
      engine: 'yjs',
      documents: { 'researches/:id/writing': defineDocument({ authorize: async () => allow() }) },
    });

    await expect(manager.authorize({ userId: '42' }, 'secrets/1')).resolves.toEqual({
      canRead: false,
      canWrite: false,
      canComment: false,
    });
  });
});

function allow() {
  return { canRead: true, canWrite: true, canComment: true };
}
