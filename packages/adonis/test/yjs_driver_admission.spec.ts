import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationAdmission, CollabPermission } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * `beginAdmission` and `isEphemeralRoom` through a real socket.
 *
 * Calling the hooks directly is how the earlier Hocuspocus bugs hid (see
 * yjs_driver_ws.spec.ts): the only proof that counts is a `HocuspocusProvider`
 * talking to the driver's own upgrade handler.
 */
const allow = async (): Promise<CollabPermission> => ({
  canRead: true,
  canWrite: true,
  canComment: true,
});

function waitFor<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
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

type Event = 'begin' | 'connected' | 'closed';

function recordingAdmissions() {
  const events: Array<{ docName: string; event: Event }> = [];
  return {
    events,
    async beginAdmission(_ctx: unknown, docName: string): Promise<CollaborationAdmission> {
      events.push({ docName, event: 'begin' });
      return {
        async connected() {
          events.push({ docName, event: 'connected' });
        },
        async closed() {
          events.push({ docName, event: 'closed' });
        },
      };
    },
  };
}

describe('YjsDriver admission and ephemeral rooms (real socket)', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  async function serve(options: ConstructorParameters<typeof YjsDriver>[0]) {
    const driver = new YjsDriver({ tokenSecret: TEST_TOKEN_SECRET, path: '/collab', ...options });
    teardown.push(() => driver.close());
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await driver.attach(server);
    const { port } = server.address() as AddressInfo;
    return { driver, url: `ws://127.0.0.1:${port}/collab` };
  }

  function connect(url: string, docName: string, document = new Y.Doc()) {
    let failure: string | undefined;
    let synced = false;
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document,
      token: testToken(docName, 'user-1'),
      onSynced: ({ state }) => {
        if (state) synced = true;
      },
      onAuthenticationFailed: ({ reason }) => {
        failure = reason;
      },
    });
    teardown.push(() => provider.destroy());
    return {
      provider,
      document,
      synced: () => synced,
      failure: () => failure,
    };
  }

  it('ends a successful handshake with connected() only — a later disconnect is not an admission event', async () => {
    const admissions = recordingAdmissions();
    const { url } = await serve({
      authorize: allow,
      storage: new InMemoryCollaborationStorage(),
      beginAdmission: admissions.beginAdmission,
    });
    const docName = 'rooms/1';
    const client = connect(url, docName);
    await waitFor(() => client.synced(), 'the client to sync');
    await waitFor(
      () => admissions.events.some((entry) => entry.event === 'connected'),
      'the admission to connect',
    );

    client.provider.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(admissions.events).toEqual([
      { docName, event: 'begin' },
      { docName, event: 'connected' },
    ]);
  });

  it('closes the admission when authorize denies the socket, and never connects it', async () => {
    const admissions = recordingAdmissions();
    const { url } = await serve({
      authorize: async () => ({ canRead: false, canWrite: false, canComment: false }),
      storage: new InMemoryCollaborationStorage(),
      beginAdmission: admissions.beginAdmission,
    });
    const client = connect(url, 'rooms/denied');
    await waitFor(() => client.failure(), 'the handshake to be refused');

    await waitFor(
      () => admissions.events.some((entry) => entry.event === 'closed'),
      'the admission to close',
    );
    expect(admissions.events.map((entry) => entry.event)).toEqual(['begin', 'closed']);
  });

  it('closes the admission when authorize throws', async () => {
    const admissions = recordingAdmissions();
    const { url } = await serve({
      authorize: async () => {
        throw new Error('permission store unavailable');
      },
      storage: new InMemoryCollaborationStorage(),
      beginAdmission: admissions.beginAdmission,
    });
    const client = connect(url, 'rooms/unknown');
    await waitFor(() => client.failure(), 'the handshake to be refused');

    await waitFor(
      () => admissions.events.some((entry) => entry.event === 'closed'),
      'the admission to close',
    );
    expect(admissions.events.map((entry) => entry.event)).toEqual(['begin', 'closed']);
  });

  it('never writes an ephemeral room to storage and unloads it when the last client leaves', async () => {
    const storage = new InMemoryCollaborationStorage();
    const saved: string[] = [];
    const saveDocument = storage.saveDocument.bind(storage);
    storage.saveDocument = async (docName, state, meta) => {
      saved.push(docName);
      return saveDocument(docName, state, meta);
    };
    // The host owns the room's durable state and serves it through loadDocument.
    const hostOwned = new Y.Doc();
    hostOwned.getText('body').insert(0, 'from the host');
    await saveDocument('writing/owned', Y.encodeStateAsUpdate(hostOwned));
    saved.length = 0;

    const { driver, url } = await serve({
      authorize: allow,
      storage,
      debounce: 25,
      isEphemeralRoom: (docName) => docName.startsWith('writing/'),
    });

    const client = connect(url, 'writing/owned');
    await waitFor(() => client.synced(), 'the client to sync');
    expect(client.document.getText('body').toString()).toBe('from the host');

    client.document.getText('body').insert(0, 'typed ');
    await waitFor(
      () => driver.liveDocument('writing/owned')?.getText('body').toString().startsWith('typed '),
      'the edit to reach the live room',
    );

    client.provider.destroy();
    // Before: onStoreDocument/beforeUnloadDocument threw for a host-owned room,
    // Hocuspocus kept the document in memory, and the next socket was served
    // that stale copy instead of what the host loads.
    await waitFor(() => driver.liveDocument('writing/owned') === undefined, 'the room to unload');
    expect(saved).toEqual([]);

    await expect(driver.createVersion('writing/owned', 'user-1', null)).rejects.toThrow(
      /Ephemeral rooms/,
    );
    await expect(driver.restoreVersion('writing/owned', 'any', 'user-1')).rejects.toThrow(
      /Ephemeral rooms/,
    );
  });

  it('still stores regular rooms next to ephemeral ones', async () => {
    const storage = new InMemoryCollaborationStorage();
    const { url } = await serve({
      authorize: allow,
      storage,
      debounce: 25,
      isEphemeralRoom: (docName) => docName.startsWith('writing/'),
    });
    const client = connect(url, 'whiteboards/1');
    await waitFor(() => client.synced(), 'the client to sync');
    client.document.getText('body').insert(0, 'kept');

    const stored = await waitFor(async () => {
      const loaded = await storage.loadDocument('whiteboards/1');
      if (!loaded) return null;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.state);
      return doc.getText('body').toString() === 'kept' ? loaded : null;
    }, 'the regular room to be stored');
    expect(stored.state.byteLength).toBeGreaterThan(0);
  });
});
