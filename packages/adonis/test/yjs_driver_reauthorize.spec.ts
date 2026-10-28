import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabConnectionContext, CollabPermission } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * `authorize` used to run only at the handshake: someone removed from a
 * document kept writing to it for as long as their tab stayed open. Open
 * sockets are now re-checked once their permission is older than
 * `reauthorizeEveryMs`, before the next message is applied.
 *
 * Through a real socket, like yjs_driver_admission.spec.ts: calling the hook
 * directly would not prove Hocuspocus honours what it sets.
 */
const FULL: CollabPermission = { canRead: true, canWrite: true, canComment: true };
const READ_ONLY: CollabPermission = { canRead: true, canWrite: false, canComment: false };
const NONE: CollabPermission = { canRead: false, canWrite: false, canComment: false };
const WINDOW_MS = 50;

function waitFor<T>(
  probe: () => T | null | undefined | false,
  label: string,
  { timeoutMs = 4000, everyMs = 25 } = {},
): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = probe();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, everyMs);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('YjsDriver re-authorizes open sockets', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  /** Permissions per user, changeable while the sockets are open. */
  async function serve(
    grants: Map<string, CollabPermission | Error>,
    reauthorizeEveryMs: number = WINDOW_MS,
  ) {
    const driver = new YjsDriver({
      tokenSecret: TEST_TOKEN_SECRET,
      path: '/collab',
      storage: new InMemoryCollaborationStorage(),
      reauthorizeEveryMs,
      authorize: async (ctx: CollabConnectionContext) => {
        const grant = grants.get(ctx.userId) ?? NONE;
        if (grant instanceof Error) throw grant;
        return grant;
      },
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
    return `ws://127.0.0.1:${port}/collab`;
  }

  async function connect(url: string, docName: string, userId: string) {
    const document = new Y.Doc();
    let synced = false;
    let closed = false;
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document,
      token: testToken(docName, userId),
      onSynced: ({ state }) => {
        if (state) synced = true;
      },
      onClose: () => {
        closed = true;
      },
    });
    teardown.push(() => provider.destroy());
    await waitFor(() => synced, `${userId} to sync`);
    return { provider, text: document.getText('t'), closed: () => closed };
  }

  it('stops applying writes once the user loses canWrite', async () => {
    const grants = new Map<string, CollabPermission | Error>([
      ['writer', FULL],
      ['watcher', FULL],
    ]);
    const url = await serve(grants);
    const writer = await connect(url, 'docs/1', 'writer');
    const watcher = await connect(url, 'docs/1', 'watcher');

    writer.text.insert(0, 'a');
    await waitFor(() => watcher.text.toString() === 'a', 'the first write to land');

    grants.set('writer', READ_ONLY);
    await sleep(WINDOW_MS * 2);
    writer.text.insert(1, 'b');
    await sleep(300);

    expect(watcher.text.toString()).toBe('a');
  });

  it('closes the socket once the user loses canRead', async () => {
    const grants = new Map<string, CollabPermission | Error>([['reader', FULL]]);
    const url = await serve(grants);
    const reader = await connect(url, 'docs/2', 'reader');
    reader.provider.setAwarenessField('typing', true);

    grants.set('reader', NONE);
    await sleep(WINDOW_MS * 2);
    reader.text.insert(0, 'x');

    await waitFor(() => reader.closed(), 'the socket to be closed');
  });

  it('turns the socket read-only while authorize throws, and back once it answers', async () => {
    const grants = new Map<string, CollabPermission | Error>([
      ['writer', FULL],
      ['watcher', FULL],
    ]);
    const url = await serve(grants);
    const writer = await connect(url, 'docs/3', 'writer');
    const watcher = await connect(url, 'docs/3', 'watcher');

    grants.set('writer', new Error('permission store down'));
    await sleep(WINDOW_MS * 2);
    writer.text.insert(0, 'a');
    await sleep(300);
    expect(watcher.text.toString()).toBe('');
    expect(writer.closed()).toBe(false);

    grants.set('writer', FULL);
    await sleep(WINDOW_MS * 2);
    writer.text.insert(1, 'b');
    // Yjs syncs the whole state again once writes are accepted: both land.
    writer.provider.forceSync();
    await waitFor(() => watcher.text.toString().includes('b'), 'writes to resume');
  });

  it('keeps the handshake decision with reauthorizeEveryMs: 0', async () => {
    const grants = new Map<string, CollabPermission | Error>([
      ['writer', FULL],
      ['watcher', FULL],
    ]);
    const url = await serve(grants, 0);
    const writer = await connect(url, 'docs/4', 'writer');
    const watcher = await connect(url, 'docs/4', 'watcher');

    grants.set('writer', READ_ONLY);
    await sleep(WINDOW_MS * 2);
    writer.text.insert(0, 'a');

    await waitFor(() => watcher.text.toString() === 'a', 'the write to land');
  });
});
