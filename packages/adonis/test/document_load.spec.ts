import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as A from '@automerge/automerge';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollabDocumentSeed } from '../src/documents.js';
import { AutomergeDriver } from '../src/drivers/automerge/automerge_driver.js';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { onCollaborationError, setCollaborationLogger } from '../src/observability.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationConfig, CollaborationStorage } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * The `load` hook of a document declaration.
 *
 * A document whose real content lives somewhere else (a column, an import)
 * used to be the app's problem to seed, and the only lever it had was a
 * request it *believed* preceded the WebSocket. When that belief was wrong the
 * editor mounted against an empty CRDT document and the first autosave wrote
 * the emptiness over the text in the database — a dissertation, on 2026-08-28.
 * These tests pin the four things that make the hook safe to rely on: it runs
 * only for a document the storage has never seen, its result is persisted, a
 * failure opens the document empty instead of closing the socket, and two
 * connections racing on a new document seed it once.
 */

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

/**
 * What Hocuspocus 4 does with the hook's result: it applies a `Y.Doc` or a
 * `Uint8Array` to the document it is loading, and ignores anything else.
 */
type LoadDocumentHook = (payload: {
  documentName: string;
}) => Promise<Uint8Array | Y.Doc | undefined>;

/** The driver's own `onLoadDocument`, the hook Hocuspocus calls per document. */
function loadHookOf(driver: YjsDriver): LoadDocumentHook {
  const { hocuspocus } = driver as unknown as {
    hocuspocus: { configuration: { onLoadDocument: LoadDocumentHook } };
  };
  return hocuspocus.configuration.onLoadDocument;
}

function paragraph(text: string): Y.Doc {
  const doc = new Y.Doc();
  const node = new Y.XmlElement('paragraph');
  node.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(0, [node]);
  return doc;
}

function textOf(state: Uint8Array | Y.Doc | undefined): string {
  if (!state) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state instanceof Y.Doc ? Y.encodeStateAsUpdate(state) : state);
  return doc.getXmlFragment('default').toString();
}

afterEach(() => {
  setCollaborationLogger(undefined);
});

describe('YjsDriver: seeding a document the storage has never stored', () => {
  it('never asks the hook for a document that is already persisted', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    await storage.saveDocument('researches/1/writing', Y.encodeStateAsUpdate(paragraph('saved')));

    const seedDocument = vi.fn<() => Promise<CollabDocumentSeed>>(async () =>
      Y.encodeStateAsUpdate(paragraph('seed')),
    );
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument,
    });

    const loaded = await loadHookOf(driver)({ documentName: 'researches/1/writing' });

    expect(seedDocument).not.toHaveBeenCalled();
    expect(textOf(loaded)).toContain('saved');
  });

  it('seeds an unknown document, persists the seed, and never asks twice', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const seedDocument = vi.fn<(docName: string) => Promise<CollabDocumentSeed>>(async () =>
      Y.encodeStateAsUpdate(paragraph('from the database')),
    );
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument,
    });
    const onLoadDocument = loadHookOf(driver);

    const loaded = await onLoadDocument({ documentName: 'researches/1/writing' });
    expect(textOf(loaded)).toContain('from the database');
    expect(seedDocument).toHaveBeenCalledWith('researches/1/writing');

    // Persisted right there: the hook cannot depend on a later flush, because
    // a seed applied during loading never marks the document dirty.
    const stored = await storage.loadDocument('researches/1/writing');
    expect(stored, 'the seed was only applied in memory').not.toBeNull();
    expect(textOf(stored!.state)).toContain('from the database');

    // …so the next connection is served by the storage, and the app pays the
    // read once instead of once per connection.
    const again = await onLoadDocument({ documentName: 'researches/1/writing' });
    expect(textOf(again)).toContain('from the database');
    expect(seedDocument).toHaveBeenCalledTimes(1);
  });

  it('accepts a Y.Doc as well as an update, and treats null as nothing to seed', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument: async (docName) => (docName === 'empty' ? null : paragraph('a whole doc')),
    });
    const onLoadDocument = loadHookOf(driver);

    const seeded = await onLoadDocument({ documentName: 'researches/1/writing' });
    expect(textOf(seeded)).toContain('a whole doc');

    // Nothing to seed leaves Hocuspocus with its own empty document, and
    // writes nothing — the hook gets another chance next time.
    expect(await onLoadDocument({ documentName: 'empty' })).toBeUndefined();
    expect(await storage.loadDocument('empty')).toBeNull();
  });

  it('opens the document empty when the hook throws, and reports it', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const failure = new Error('the database is down');
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument: async () => {
        throw failure;
      },
    });

    const reported: unknown[] = [];
    const unsubscribe = onCollaborationError((event) => reported.push(event.error));

    // Not a rejection: Hocuspocus turns a throwing onLoadDocument into a
    // closed connection, and the client only reconnects and runs it again.
    await expect(
      loadHookOf(driver)({ documentName: 'researches/1/writing' }),
    ).resolves.toBeUndefined();
    unsubscribe();

    expect(reported).toEqual([failure]);
    expect(await storage.loadDocument('researches/1/writing')).toBeNull();
  });

  it('seeds once when two connections open the same new document at the same time', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    let calls = 0;
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      // Slow on purpose: the second connection arrives while the first is
      // still reading, which is exactly the window two seeds appear in.
      seedDocument: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return paragraph('written once');
      },
    });
    const onLoadDocument = loadHookOf(driver);

    const [first, second] = await Promise.all([
      onLoadDocument({ documentName: 'researches/1/writing' }),
      onLoadDocument({ documentName: 'researches/1/writing' }),
    ]);

    expect(calls, 'the seed ran twice — the document would hold the text twice').toBe(1);
    for (const loaded of [first, second]) {
      const text = textOf(loaded);
      expect(text).toContain('written once');
      expect(text.match(/written once/g)).toHaveLength(1);
    }
  });

  it('keeps the seed across an unload: what is persisted still holds it', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument: async () => paragraph('seeded'),
    });
    const hooks = (
      driver as unknown as {
        hocuspocus: {
          configuration: {
            onLoadDocument: LoadDocumentHook;
            beforeUnloadDocument: (payload: {
              documentName: string;
              document: Y.Doc;
            }) => Promise<void>;
          };
        };
      }
    ).hocuspocus.configuration;

    const seed = await hooks.onLoadDocument({ documentName: 'researches/1/writing' });
    // Hocuspocus applies the hook's result to the document it is loading; the
    // last client leaving then flushes that document as it stands, so the
    // flush must not blank what the hook just wrote.
    const live = new Y.Doc();
    Y.applyUpdate(live, seed instanceof Y.Doc ? Y.encodeStateAsUpdate(seed) : seed!);
    await hooks.beforeUnloadDocument({ documentName: 'researches/1/writing', document: live });

    const stored = await storage.loadDocument('researches/1/writing');
    expect(textOf(stored!.state)).toContain('seeded');
  });
});

describe('CollaborationManager: load resolved from the declaration', () => {
  const config = (overrides: Partial<CollaborationConfig> = {}): CollaborationConfig => ({
    engine: 'yjs',
    authorize: allow,
    tokenSecret: TEST_TOKEN_SECRET,
    storage: new InMemoryCollaborationStorage(),
    ...overrides,
  });

  async function yjsDriverOf(manager: CollaborationManager): Promise<YjsDriver> {
    // The manager materialises the default engine's driver in its own
    // constructor, but resolving the engine is async — the driver lands in the
    // registry a microtask later than `new CollaborationManager()` returns.
    await manager.engineFor({ docName: 'anything' });
    const { drivers } = manager as unknown as { drivers: Map<string, YjsDriver> };
    return drivers.get('yjs')!;
  }

  it('hands the hook the docName and the params of the matched pattern', async () => {
    const seen: Array<{ docName: string; params: Record<string, string> }> = [];
    const manager = new CollaborationManager(
      config({
        documents: {
          'researches/:id/writing': {
            async load(info) {
              seen.push(info);
              return paragraph(`research ${info.params.id}`);
            },
          },
        },
      }),
    );

    const loaded = await loadHookOf(await yjsDriverOf(manager))({
      documentName: 'researches/42/writing',
    });

    expect(seen).toEqual([{ docName: 'researches/42/writing', params: { id: '42' } }]);
    expect(textOf(loaded)).toContain('research 42');
  });

  it('leaves a document with no declared load alone', async () => {
    const manager = new CollaborationManager(
      config({ documents: { 'researches/:id/writing': {} } }),
    );

    await expect(
      loadHookOf(await yjsDriverOf(manager))({ documentName: 'whiteboards/9' }),
    ).resolves.toBeUndefined();
  });

  it('serves the seed to a client that connects over the WebSocket', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const manager = new CollaborationManager(
      config({
        storage,
        path: '/collab',
        documents: {
          'researches/:id/writing': {
            async load({ params }) {
              return paragraph(`the body of research ${params.id}`);
            },
          },
        },
      }),
    );

    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await manager.attach(server);
    const { port } = server.address() as AddressInfo;

    const doc = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the server never synced')), 4000);
        provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${port}/collab`,
          name: 'researches/7/writing',
          document: doc,
          token: testToken('researches/7/writing'),
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

      // The client's editor mounts against THIS document. Empty here is what
      // the autosave would have written back over the real text.
      expect(doc.getXmlFragment('default').toString()).toContain('the body of research 7');
    } finally {
      provider?.destroy();
      await manager.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('AutomergeDriver: the same hook, in the engine that has its own rooms', () => {
  const seedBytes = (content: string) => A.save(A.from({ content }));

  it('seeds a cold room from the declared bytes and persists them', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const seedDocument = vi.fn<() => Promise<CollabDocumentSeed>>(async () =>
      seedBytes('imported'),
    );
    const driver = new AutomergeDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument,
    });

    await expect(driver.getDocumentText('whiteboards/1')).resolves.toBe('imported');
    expect((await storage.loadDocument('whiteboards/1'))?.state.byteLength).toBeGreaterThan(0);

    // The room is warm and the storage has it: nothing asks again.
    await driver.getDocumentText('whiteboards/1');
    expect(seedDocument).toHaveBeenCalledTimes(1);
    await driver.close();
  });

  it('opens two concurrent readers on one room, seeded once', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    let calls = 0;
    const driver = new AutomergeDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return seedBytes('once');
      },
    });

    const [a, b] = await Promise.all([
      driver.getDocumentText('whiteboards/1'),
      driver.getDocumentText('whiteboards/1'),
    ]);

    expect(calls).toBe(1);
    expect([a, b]).toEqual(['once', 'once']);
    await driver.close();
  });

  it('opens empty when the hook throws or answers with a Yjs document', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const warn = vi.fn();
    setCollaborationLogger({ error: vi.fn(), warn });

    const driver = new AutomergeDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      seedDocument: async (docName) => {
        if (docName === 'whiteboards/boom') throw new Error('nope');
        // A Y.Doc is a Yjs convenience; an Automerge seed is A.save() bytes.
        return paragraph('wrong engine');
      },
    });

    const reported: unknown[] = [];
    const unsubscribe = onCollaborationError((event) => reported.push(event.operation));
    await expect(driver.getDocumentText('whiteboards/boom')).resolves.toBe('');
    unsubscribe();
    expect(reported).toEqual(['loadDocument']);

    await expect(driver.getDocumentText('whiteboards/1')).resolves.toBe('');
    expect(warn.mock.calls[0]?.[1]).toContain('automerge');
    await driver.close();
  });
});
