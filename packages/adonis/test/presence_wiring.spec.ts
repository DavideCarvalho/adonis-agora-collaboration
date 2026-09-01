import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { PresenceMember, PresenceStore } from '../src/services/presence_service.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * Presence had two independent defects that produced the same wrong answer.
 *
 * 1. **Nothing fed the store.** The provider built a `RedisPresenceStore` from
 *    `redisUrl` and the manager wrapped it in a `PresenceService`, but
 *    `#buildDriver` never passed `presence` into the driver options — and the
 *    driver's join/leave both guard on `options.presence`. Dead code, and
 *    `listPresence()` returned `[]` forever.
 *
 * 2. **One slot per document.** The bookkeeping was a module-level
 *    `Map<docName, userId>`, so a second editor overwrote the first and the
 *    first disconnect evicted the wrong person.
 *
 * The test drives the real Hocuspocus hooks the driver registers, so it fails
 * if either regresses.
 *
 * It drives them **in order** — `onAuthenticate` and then `connected` — which
 * is the third defect: presence used to be filled from `onConnect`, decoding
 * `?token=` off the query string a second time and without checking anything.
 * A roster built that way shows whoever the client claimed to be, even with a
 * handshake that verifies signatures. Identity is established once, and every
 * later hook reads it from the connection context.
 */

class FakeStore implements PresenceStore {
  private data = new Map<string, Map<string, PresenceMember>>();

  async join(docName: string, member: PresenceMember): Promise<void> {
    if (!this.data.has(docName)) this.data.set(docName, new Map());
    this.data.get(docName)!.set(member.userId, member);
  }
  async leave(docName: string, userId: string): Promise<void> {
    this.data.get(docName)?.delete(userId);
  }
  async list(docName: string): Promise<PresenceMember[]> {
    return [...(this.data.get(docName)?.values() ?? [])];
  }
  async close(): Promise<void> {}
}

interface Hooks {
  onAuthenticate(payload: unknown): Promise<unknown>;
  connected(payload: unknown): Promise<unknown>;
  onDisconnect(payload: unknown): Promise<unknown>;
}

async function buildManager(store?: PresenceStore) {
  const manager = new CollaborationManager(
    {
      engine: 'yjs',
      storage: new InMemoryCollaborationStorage(),
      tokenSecret: TEST_TOKEN_SECRET,
      authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
    },
    store,
  );

  // Materializes the lazily-built driver for the default engine.
  await manager.getDocumentState({ docName: 'warmup' });

  // The driver is internal; the hooks it registers on Hocuspocus are what the
  // real socket path calls, so drive those rather than a stand-in.
  const driver = (manager as unknown as { drivers: Map<string, unknown> }).drivers.get('yjs') as {
    hocuspocus: { configuration: Hooks };
  };

  // The real sequence: the token is verified once, and what that verification
  // returns is the context every later hook reads.
  const connect = async (docName: string, socketId: string, userId: string, name?: string) => {
    const context = await driver.hocuspocus.configuration.onAuthenticate({
      documentName: docName,
      socketId,
      token: testToken(docName, userId, name ? { name } : {}),
      connectionConfig: { readOnly: false },
    });
    return driver.hocuspocus.configuration.connected({ documentName: docName, socketId, context });
  };

  /** A socket that never authenticated — nothing may put it on the roster. */
  const connectUnverified = (docName: string, socketId: string, userId: string) =>
    driver.hocuspocus.configuration.connected({
      documentName: docName,
      socketId,
      context: {},
      requestParameters: new URLSearchParams({
        token: Buffer.from(JSON.stringify({ userId })).toString('base64'),
      }),
    });

  const disconnect = (docName: string, socketId: string) =>
    driver.hocuspocus.configuration.onDisconnect({ documentName: docName, socketId });

  return { manager, connect, connectUnverified, disconnect };
}

const DOC = 'researches/42/writing';
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('presence is actually fed by the driver', () => {
  it('records every member of a document, not just the last one', async () => {
    const { manager, connect } = await buildManager(new FakeStore());
    close = () => manager.close();

    await connect(DOC, 'socket-a', 'u_1', 'Ana');
    await connect(DOC, 'socket-b', 'u_2', 'Bruno');

    const roster = await manager.listPresence({ docName: DOC });
    expect(roster.map((member) => member.userId).sort()).toEqual(['u_1', 'u_2']);
    expect(roster.find((member) => member.userId === 'u_1')?.name).toBe('Ana');
  });

  it('removes only the user who disconnected', async () => {
    const { manager, connect, disconnect } = await buildManager(new FakeStore());
    close = () => manager.close();

    await connect(DOC, 'socket-a', 'u_1');
    await connect(DOC, 'socket-b', 'u_2');
    await disconnect(DOC, 'socket-a');

    // A Map<docName, userId> answered [] here (it had evicted u_2's entry
    // under u_1's disconnect, and lost u_1 entirely on the way in).
    const roster = await manager.listPresence({ docName: DOC });
    expect(roster.map((member) => member.userId)).toEqual(['u_2']);
  });

  it('keeps a user in the roster while any of their tabs is still open', async () => {
    const { manager, connect, disconnect } = await buildManager(new FakeStore());
    close = () => manager.close();

    await connect(DOC, 'tab-1', 'u_1');
    await connect(DOC, 'tab-2', 'u_1');
    await disconnect(DOC, 'tab-1');

    expect(await manager.listPresence({ docName: DOC })).toHaveLength(1);

    await disconnect(DOC, 'tab-2');
    expect(await manager.listPresence({ docName: DOC })).toEqual([]);
  });

  it('keeps documents isolated', async () => {
    const { manager, connect } = await buildManager(new FakeStore());
    close = () => manager.close();

    await connect(DOC, 'socket-a', 'u_1');
    await connect('whiteboards/9', 'socket-b', 'u_2');

    expect((await manager.listPresence({ docName: DOC })).map((m) => m.userId)).toEqual(['u_1']);
    expect((await manager.listPresence({ docName: 'whiteboards/9' })).map((m) => m.userId)).toEqual(
      ['u_2'],
    );
  });

  it('never records an identity the handshake did not verify', async () => {
    const { manager, connectUnverified } = await buildManager(new FakeStore());
    close = () => manager.close();

    // The forged claim that used to work: base64 JSON in the query string,
    // read by `onConnect` before anything checked a signature.
    await connectUnverified(DOC, 'socket-forged', 'u_victim');

    expect(await manager.listPresence({ docName: DOC })).toEqual([]);
  });

  it('stays quiet with no store configured (single-instance dev)', async () => {
    const { manager, connect, disconnect } = await buildManager(undefined);
    close = () => manager.close();

    await connect(DOC, 'socket-a', 'u_1');
    await disconnect(DOC, 'socket-a');

    expect(await manager.listPresence({ docName: DOC })).toEqual([]);
  });
});
