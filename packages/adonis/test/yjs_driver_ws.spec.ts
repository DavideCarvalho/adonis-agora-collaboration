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
 * The WebSocket the driver mounts has to actually reach Hocuspocus.
 *
 * `@hocuspocus/server` 4 does not listen on the socket it is handed:
 * `handleConnection` takes a `WebSocketLike` (send/close/readyState) and returns
 * a `ClientConnection` the integrator must feed with `handleMessage` and
 * `handleClose` — the package's own `Server` does it through crossws hooks.
 * `attach()` used to call `handleConnection` and drop the return value, which
 * produced a server that looked alive and was deaf: the socket opened, the
 * client sent Auth + SyncStep1 + Awareness, and nothing ever came back. No
 * `onLoadDocument`, no `onStoreDocument`, every version a 2-byte snapshot.
 *
 * This test goes through the real thing end to end: a node HTTP server, the
 * driver's own upgrade handler, and the same `HocuspocusProvider` a browser
 * uses (Node ≥ 22 ships a global `WebSocket`).
 */
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

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

describe('YjsDriver attach(): the socket feeds Hocuspocus', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  it('authenticates, syncs, stores what the client writes and snapshots a non-empty version', async () => {
    const storage: CollaborationStorage = new InMemoryCollaborationStorage();
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
    const docName = 'researches/1/writing';
    let provider: HocuspocusProvider | undefined;
    teardown.push(() => provider?.destroy());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server never answered the sync')), 4000);
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: docName,
        document: doc,
        // A real credential: signed with the server's key, bound to this
        // document, minted seconds ago.
        token: testToken(docName, 'user-1'),
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

    // Typing on the client lands in the server's live document…
    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('hello from the client')]);
      doc.getXmlFragment('default').insert(0, [paragraph]);
    });
    const liveText = await waitFor(async () => {
      const text = await driver.getDocumentText(docName);
      return text.includes('hello from the client') ? text : null;
    }, 'the live document to receive the update');
    expect(liveText).toContain('hello from the client');

    // …and the debounced onStoreDocument persists it.
    const stored = await waitFor(
      async () => (await storage.loadDocument(docName)) ?? null,
      'onStoreDocument to persist the document',
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, stored.state);
    expect(restored.getXmlFragment('default').toString()).toContain('hello from the client');

    // A version taken now is a real snapshot, not the 2-byte empty doc.
    const version = await driver.createVersion(docName, 'user-1', null);
    const snapshot = await storage.loadVersionSnapshot(docName, version.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.byteLength).toBeGreaterThan(2);
  });

  it('rejects a bad token by closing the socket instead of leaving it hanging', async () => {
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage: new InMemoryCollaborationStorage(),
      path: '/collab',
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

    let provider: HocuspocusProvider | undefined;
    teardown.push(() => provider?.destroy());
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the server never reacted to the bad token')),
        4000,
      );
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: 'researches/2/writing',
        document: new Y.Doc(),
        token: 'not-a-token',
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          resolve(reason);
        },
      });
    });
    expect(reason).toBeTruthy();
  });
});
