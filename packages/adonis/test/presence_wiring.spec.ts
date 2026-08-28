import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { PresenceMember, PresenceStore } from '../src/services/presence_service.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';

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

/** The legacy base64 payload the self-hosted handshake speaks. */
function token(userId: string, name?: string): string {
  return Buffer.from(JSON.stringify({ userId, ...(name ? { user: { name } } : {}) })).toString(
    'base64',
  );
}

interface Hooks {
  onConnect(payload: unknown): Promise<unknown>;
  onDisconnect(payload: unknown): Promise<unknown>;
}

async function buildManager(store?: PresenceStore) {
  const manager = new CollaborationManager(
    {
      engine: 'yjs',
      storage: new InMemoryCollaborationStorage(),
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

  const connect = (docName: string, socketId: string, userId: string, name?: string) =>
    driver.hocuspocus.configuration.onConnect({
      documentName: docName,
      socketId,
      requestParameters: new URLSearchParams({ token: token(userId, name) }),
    });

  const disconnect = (docName: string, socketId: string) =>
    driver.hocuspocus.configuration.onDisconnect({ documentName: docName, socketId });

  return { manager, connect, disconnect };
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

  it('stays quiet with no store configured (single-instance dev)', async () => {
    const { manager, connect, disconnect } = await buildManager(undefined);
    close = () => manager.close();

    await connect(DOC, 'socket-a', 'u_1');
    await disconnect(DOC, 'socket-a');

    expect(await manager.listPresence({ docName: DOC })).toEqual([]);
  });
});
