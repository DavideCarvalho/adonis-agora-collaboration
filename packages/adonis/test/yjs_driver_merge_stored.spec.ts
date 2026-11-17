import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { type StorageCodec, withCodec } from '../src/storage/codec.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationStorage } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * Saving a live document REPLACES what storage holds. Another process that
 * changed the stored state in the meantime (a sync job merging an external
 * edit, a second instance) used to lose that change on the next autosave of
 * the live copy — silently. Every write of a live document now merges the
 * stored state in first.
 */
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;
const DOC = 'researches/7/writing';

/** AES-256-GCM, so the merge is proven through a codec that changes the bytes at rest. */
function aesCodec(key: Buffer): StorageCodec {
  return {
    async encode(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
      const body = Buffer.concat([cipher.update(input), cipher.final()]);
      const out = Buffer.concat([iv, cipher.getAuthTag(), body]);
      return typeof plaintext === 'string' ? out.toString('base64') : new Uint8Array(out);
    },
    async decode(encoded, ctx) {
      const raw =
        typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.from(encoded);
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return ctx.field === 'body' || ctx.field === 'anchor'
        ? plain.toString('utf8')
        : new Uint8Array(plain);
    },
  };
}

function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc.getText('content').toString();
}

/** What another process does: read the stored state, change it, save it back. */
async function writeOutOfBand(storage: CollaborationStorage, change: (doc: Y.Doc) => void) {
  const stored = await storage.loadDocument(DOC);
  const doc = new Y.Doc();
  if (stored?.state) Y.applyUpdate(doc, stored.state);
  change(doc);
  await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));
}

type Hook = (payload: { documentName: string; document: Y.Doc }) => Promise<unknown>;

function hooksOf(driver: YjsDriver) {
  return (driver as unknown as { hocuspocusConfig: Record<string, Hook> }).hocuspocusConfig;
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('YjsDriver keeps what another process stored', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  for (const hook of ['onStoreDocument', 'beforeUnloadDocument'] as const) {
    it(`${hook} merges the stored state before replacing it`, async () => {
      const storage = new InMemoryCollaborationStorage();
      const seed = new Y.Doc();
      seed.getText('content').insert(0, 'base');
      await storage.saveDocument(DOC, Y.encodeStateAsUpdate(seed));

      const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
      const hooks = hooksOf(driver);

      // Process A loads the document…
      const live = new Y.Doc();
      Y.applyUpdate(live, (await storage.loadDocument(DOC))!.state);
      await hooks.afterLoadDocument!({ documentName: DOC, document: live });

      // …process B changes the stored state…
      await writeOutOfBand(storage, (doc) => doc.getText('content').insert(4, ' +drive'));

      // …and A's next write, which never heard of it, must keep it.
      live.getText('content').insert(0, '>');
      await hooks[hook]!({ documentName: DOC, document: live });

      const stored = textOf((await storage.loadDocument(DOC))!.state);
      expect(stored).toBe('>base +drive');
      // The live document caught up too, so the clients see the change.
      expect(live.getText('content').toString()).toBe('>base +drive');
    });
  }

  it('brings the stored state in without scheduling another store (no loop)', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
    const hooks = hooksOf(driver);

    const live = new Y.Doc();
    await hooks.afterLoadDocument!({ documentName: DOC, document: live });
    await writeOutOfBand(storage, (doc) => doc.getText('content').insert(0, 'de fora'));

    const origins: unknown[] = [];
    live.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
    live.getText('content').insert(0, 'x');
    await hooks.onStoreDocument!({ documentName: DOC, document: live });

    // The keystroke (no origin) and the merge — marked so Hocuspocus does not
    // run the store hooks for it.
    expect(origins).toHaveLength(2);
    expect(origins[1]).toEqual({ source: 'local', skipStoreHooks: true });

    // Storing again with nothing new neither merges nor writes.
    let saves = 0;
    const save = storage.saveDocument.bind(storage);
    storage.saveDocument = async (...args) => {
      saves += 1;
      return save(...args);
    };
    await hooks.onStoreDocument!({ documentName: DOC, document: live });
    expect(saves).toBe(0);
    expect(origins).toHaveLength(2);
  });

  it('does not write when the stored state cannot be read', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
    const hooks = hooksOf(driver);
    await writeOutOfBand(storage, (doc) => doc.getText('content').insert(0, 'precioso'));

    const live = new Y.Doc();
    live.getText('content').insert(0, 'x');
    storage.loadDocument = async () => {
      throw new Error('database down');
    };
    let saved = false;
    storage.saveDocument = async () => {
      saved = true;
    };
    await expect(hooks.onStoreDocument!({ documentName: DOC, document: live })).rejects.toThrow(
      'database down',
    );
    expect(saved).toBe(false);
  });

  it('two processes over an encrypted store: the autosave of the live copy keeps the out-of-band write', async () => {
    const storage = withCodec(new InMemoryCollaborationStorage(), aesCodec(randomBytes(32)));
    const seed = new Y.Doc();
    seed.getText('content').insert(0, 'tese');
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(seed));

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

    const client = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    teardown.push(() => provider?.destroy());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sync')), 4000);
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: DOC,
        document: client,
        token: testToken(DOC),
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          resolve();
        },
      });
    });

    // The other process (a sync worker) writes to storage; no message reaches
    // this one — the delta it would have published is lost.
    await writeOutOfBand(storage, (doc) => doc.getText('content').insert(4, ' do Drive'));

    // The person keeps typing; the debounced autosave of the live copy runs.
    client.getText('content').insert(0, '# ');
    await waitFor(
      async () => textOf((await storage.loadDocument(DOC))!.state).startsWith('# '),
      'the autosave',
    );

    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('# tese do Drive');
    // And the editor received it through the normal sync.
    await waitFor(
      async () => client.getText('content').toString() === '# tese do Drive',
      'the client to receive the merged change',
    );
  });

  it('getStoredDocumentState answers with storage, not the live copy', async () => {
    const storage = new InMemoryCollaborationStorage();
    const manager = new CollaborationManager({
      engine: 'yjs',
      storage,
      tokenSecret: TEST_TOKEN_SECRET,
    } as never);
    await writeOutOfBand(storage, (doc) => doc.getText('content').insert(0, 'gravado'));
    expect(textOf(await manager.getStoredDocumentState({ docName: DOC }))).toBe('gravado');
    expect(
      (await manager.getStoredDocumentState({ docName: 'researches/8/writing' })).byteLength,
    ).toBe(0);
  });
});
