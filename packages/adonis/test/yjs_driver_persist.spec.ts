import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationStorage } from '../src/types.js';

/**
 * Regressão do `onLoadDocument` do YjsDriver.
 *
 * O Hocuspocus NÃO carrega o estado persistido por conta própria: sem o hook
 * `onLoadDocument`, cada conexão cria um Y.Doc VAZIO em memória e o conteúdo
 * salvo jamais volta pro cliente (lousa que sempre abre em branco). Este teste
 * garante que o hook existe e semeia o doc a partir do storage.
 */
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

describe('YjsDriver onLoadDocument (persistência round-trip)', () => {
  it('seeds the in-memory document from storage when a connection loads it', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const seed = new Y.Doc();
    seed.getText('content').insert(0, 'persistido');
    await storage.saveDocument('prova/1', Y.encodeStateAsUpdate(seed));

    const driver = new YjsDriver({ authorize: allow, storage, path: '/collab' });
    const hocuspocus = (
      driver as unknown as {
        hocuspocus: {
          configuration: {
            onLoadDocument?: (payload: { documentName: string }) => Promise<
              { document: Y.Doc } | undefined
            >;
          };
        };
      }
    ).hocuspocus;

    // O hook precisa existir — é o fix.
    expect(typeof hocuspocus.configuration.onLoadDocument).toBe('function');

    const loaded = await hocuspocus.configuration.onLoadDocument!({ documentName: 'prova/1' });
    expect(loaded?.document.getText('content').toString()).toBe('persistido');
  });

  it('returns undefined (empty doc) when nothing was persisted yet', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, storage, path: '/collab' });
    const hocuspocus = (
      driver as unknown as {
        hocuspocus: {
          configuration: {
            onLoadDocument?: (payload: { documentName: string }) => Promise<
              { document: Y.Doc } | undefined
            >;
          };
        };
      }
    ).hocuspocus;

    const loaded = await hocuspocus.configuration.onLoadDocument!({ documentName: 'nova/1' });
    expect(loaded).toBeUndefined();
  });
});
