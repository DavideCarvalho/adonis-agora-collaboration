import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationConfig, CollaborationStorage } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * `withLiveDocument` / `hasLiveDocument` / `getVersionState`.
 *
 * The app that drove these into the library was reaching the live document
 * through `manager.drivers.get('yjs').liveDoc(name)` — a cast onto a private
 * field of a private map, because a copy of the state (`getDocumentState`) is
 * enough to export a document and useless for changing one. An external edit
 * (a Drive webhook, a cron) has to land in the instance people are typing
 * into, or the keystrokes since the last flush lose it, or it loses them.
 *
 * What the tests pin down: the callback runs on the real document and what it
 * writes reaches connected clients; "there is no live document here" is an
 * answer rather than an exception; and an engine that keeps its documents
 * somewhere else says so instead of blowing up in a cast.
 */
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

const config = (overrides: Partial<CollaborationConfig> = {}): CollaborationConfig => ({
  engine: 'yjs',
  authorize: allow,
  // No app around these tests, so nothing would resolve an appKey — and a
  // manager with no key refuses every handshake rather than accepting an
  // unsigned token.
  tokenSecret: TEST_TOKEN_SECRET,
  storage: new InMemoryCollaborationStorage(),
  ...overrides,
});

function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  { timeoutMs = 4000, everyMs = 25 } = {},
): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const value = await probe();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(() => void tick(), everyMs);
    };
    void tick();
  });
}

describe('CollaborationManager live document access', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  it('says the document is not loaded, and never runs the callback', async () => {
    const manager = new CollaborationManager(config());
    teardown.push(() => manager.close());
    const run = vi.fn();

    const result = await manager.withLiveDocument({ docName: 'researches/1/writing', run });

    expect(result).toEqual({ live: false, reason: 'not-loaded' });
    expect(run).not.toHaveBeenCalled();
    await expect(manager.hasLiveDocument({ docName: 'researches/1/writing' })).resolves.toBe(false);
  });

  it('says an engine that syncs elsewhere has no live document at all', async () => {
    const manager = new CollaborationManager(
      config({
        engine: 'yjs',
        partykit: { roomHost: 'localhost:1999' },
        documents: {
          // The edge engine: the document lives in a Durable Object, and no
          // cast onto this driver could produce a Y.Doc.
          'boards/:id': { engine: 'partykit' },
          // Automerge keeps rooms in this process, but an Automerge document
          // is not a Y.Doc and is immutable besides — same answer.
          'lousas/:id': { engine: 'automerge' },
        },
      }),
    );
    teardown.push(() => manager.close());
    const run = vi.fn();

    for (const docName of ['boards/1', 'lousas/1']) {
      const result = await manager.withLiveDocument({ docName, run });
      expect(result, docName).toEqual({ live: false, reason: 'engine-has-no-live-document' });
      await expect(manager.hasLiveDocument({ docName }), docName).resolves.toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('hands over the document a connected client is editing, and what it writes fans out', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const manager = new CollaborationManager(config({ storage, path: '/collab', debounce: 25 }));
    teardown.push(() => manager.close());

    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await manager.attach(server);
    const { port } = server.address() as AddressInfo;

    const docName = 'researches/1/writing';
    const clientDoc = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    teardown.push(() => provider?.destroy());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server never answered the sync')), 4000);
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: docName,
        document: clientDoc,
        token: testToken(docName),
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          resolve();
        },
      });
    });

    // The client types; those keystrokes are only in the live document.
    clientDoc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('typed by a human')]);
      clientDoc.getXmlFragment('default').insert(0, [paragraph]);
    });
    expect(await manager.hasLiveDocument({ docName })).toBe(true);
    await waitFor(async () => {
      const seen = await manager.withLiveDocument({
        docName,
        run: (document) => document.getXmlFragment('default').toString(),
      });
      return seen.live && seen.value.includes('typed by a human') ? seen.value : null;
    }, 'the live document to receive the keystrokes');

    // An external change merges into the same document — the whole point:
    // nothing the human typed is thrown away, and they see the merge.
    const result = await manager.withLiveDocument({
      docName,
      run: (document) => {
        document.transact(() => {
          const paragraph = new Y.XmlElement('paragraph');
          paragraph.insert(0, [new Y.XmlText('merged from Drive')]);
          document.getXmlFragment('default').insert(0, [paragraph]);
        });
        return document.getXmlFragment('default').toString();
      },
    });

    expect(result.live).toBe(true);
    expect(result.value).toContain('typed by a human');
    expect(result.value).toContain('merged from Drive');

    const onScreen = await waitFor(async () => {
      const text = clientDoc.getXmlFragment('default').toString();
      return text.includes('merged from Drive') ? text : null;
    }, 'the client to receive the merge');
    expect(onScreen).toContain('typed by a human');
  });

  it('returns whatever the callback returns, including undefined', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const seed = new Y.Doc();
    seed.getText('content').insert(0, 'já existia');
    await storage.saveDocument('researches/2/writing', Y.encodeStateAsUpdate(seed));

    const manager = new CollaborationManager(config({ storage, path: '/collab' }));
    teardown.push(() => manager.close());

    // A document nobody has open: `live: false` is the answer, and it is not
    // the same as a callback that legitimately returned undefined.
    const absent = await manager.withLiveDocument({
      docName: 'researches/2/writing',
      run: () => undefined,
    });
    expect(absent).toEqual({ live: false, reason: 'not-loaded' });
    expect('value' in absent && absent.value).toBeFalsy();
  });

  it('reads the binary state of a version, and refuses an unknown id', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
    const written = new Y.Doc();
    written.getText('content').insert(0, 'versão 1');
    await storage.saveDocument('researches/3/writing', Y.encodeStateAsUpdate(written));

    const manager = new CollaborationManager(config({ storage }));
    teardown.push(() => manager.close());

    const version = await manager.createVersion({
      docName: 'researches/3/writing',
      createdBy: 'user-1',
    });

    const state = await manager.getVersionState({
      docName: 'researches/3/writing',
      versionId: version.id,
    });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, state);
    expect(restored.getText('content').toString()).toBe('versão 1');

    await expect(
      manager.getVersionState({ docName: 'researches/3/writing', versionId: 'nope' }),
    ).rejects.toThrow(/nope/);
  });
});
