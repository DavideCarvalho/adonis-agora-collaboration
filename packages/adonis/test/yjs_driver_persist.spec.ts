import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationStorage } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * Regressão do `onLoadDocument` do YjsDriver.
 *
 * O Hocuspocus NÃO carrega o estado persistido por conta própria: sem o hook
 * `onLoadDocument`, cada conexão cria um Y.Doc VAZIO em memória e o conteúdo
 * salvo jamais volta pro cliente (lousa que sempre abre em branco). Este teste
 * garante que o hook existe e semeia o doc a partir do storage.
 *
 * E garante o que o hook DEVOLVE, que é metade do fix. O Hocuspocus 4 só
 * aplica o retorno quando ele é um `Y.Doc` ou um `Uint8Array`; qualquer outra
 * coisa some sem aviso. O driver devolvia `{ document }` (o formato da v1), e
 * este arquivo, que chamava o hook direto e olhava o objeto devolvido, achava
 * tudo certo enquanto todo cliente real recebia documento vazio. Por isso o
 * segundo teste agora abre um socket de verdade.
 */
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

type LoadDocumentHook = (payload: { documentName: string }) => Promise<unknown>;

function loadHookOf(driver: YjsDriver): LoadDocumentHook {
  const { hocuspocus } = driver as unknown as {
    hocuspocus: { configuration: { onLoadDocument?: LoadDocumentHook } };
  };
  // O hook precisa existir — é o fix.
  expect(typeof hocuspocus.configuration.onLoadDocument).toBe('function');
  return hocuspocus.configuration.onLoadDocument!;
}

describe('YjsDriver onLoadDocument (persistência round-trip)', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  it('returns the persisted state in a shape Hocuspocus actually applies', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const seed = new Y.Doc();
    seed.getText('content').insert(0, 'persistido');
    await storage.saveDocument('prova/1', Y.encodeStateAsUpdate(seed));

    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      path: '/collab',
    });
    const loaded = await loadHookOf(driver)({ documentName: 'prova/1' });

    // As duas únicas formas que o Hocuspocus 4 sabe aplicar.
    expect(loaded instanceof Uint8Array || loaded instanceof Y.Doc).toBe(true);

    const applied = new Y.Doc();
    Y.applyUpdate(
      applied,
      loaded instanceof Y.Doc ? Y.encodeStateAsUpdate(loaded) : (loaded as Uint8Array),
    );
    expect(applied.getText('content').toString()).toBe('persistido');
  });

  it('returns undefined (empty doc) when nothing was persisted yet', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      path: '/collab',
    });

    const loaded = await loadHookOf(driver)({ documentName: 'nova/1' });
    expect(loaded).toBeUndefined();
  });

  it('gives a connecting client the document that was saved before it arrived', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const saved = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('escrito ontem')]);
    saved.getXmlFragment('default').insert(0, [paragraph]);
    await storage.saveDocument('researches/1/writing', Y.encodeStateAsUpdate(saved));

    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      path: '/collab',
      debounce: 25,
    });
    teardown.push(() => driver.close());

    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await driver.attach(server);
    const { port } = server.address() as AddressInfo;

    const doc = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    teardown.push(() => provider?.destroy());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o servidor nunca respondeu o sync')), 4000);
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: 'researches/1/writing',
        document: doc,
        token: testToken('researches/1/writing'),
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          resolve();
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          reject(new Error(`authentication failed: ${reason}`));
        },
      });
    });

    // É este Y.Doc que o editor do cliente monta. Vazio aqui é o texto que o
    // primeiro autosave apagaria do banco.
    expect(doc.getXmlFragment('default').toString()).toContain('escrito ontem');
  });
});
