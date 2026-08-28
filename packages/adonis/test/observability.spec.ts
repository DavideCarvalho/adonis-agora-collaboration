import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollabAuthorizationError, CollabForbiddenError } from '../src/auth/token.js';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import {
  type CollabErrorEvent,
  onCollaborationError,
  setCollaborationLogger,
} from '../src/observability.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollaborationStorage } from '../src/types.js';

/**
 * The library took no logger and emitted no events, and both of its failure
 * paths ran inside hooks that swallow what they catch:
 *
 *  - `onStoreDocument`/`beforeUnloadDocument` called `storage.saveDocument`
 *    bare, so a database outage was silent — which is why a consuming app
 *    wrapped all ten `CollaborationStorage` methods in `console.error` just
 *    to see what was happening;
 *  - a throw from `authorize` escaped `onAuthenticate` as a generic handshake
 *    failure, indistinguishable from a denial, and an app-side DB error inside
 *    the rule became an unbounded reconnect storm.
 *
 * Denied and errored are now different outcomes, and both are observable.
 */

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;
const deny = async () => ({ canRead: false, canWrite: false, canComment: false }) as const;
const DOC = 'researches/42/writing';

interface Hooks {
  onAuthenticate(payload: unknown): Promise<unknown>;
  onStoreDocument(payload: unknown): Promise<unknown>;
  beforeUnloadDocument(payload: unknown): Promise<unknown>;
}

function hooksOf(driver: YjsDriver): Hooks {
  return (driver as unknown as { hocuspocus: { configuration: Hooks } }).hocuspocus.configuration;
}

function token(userId: string): string {
  return Buffer.from(JSON.stringify({ userId })).toString('base64');
}

/** Collects everything reported while the callback runs. */
async function captured(run: () => Promise<void>): Promise<CollabErrorEvent[]> {
  const events: CollabErrorEvent[] = [];
  const off = onCollaborationError((event) => events.push(event));
  try {
    await run();
  } finally {
    off();
  }
  return events;
}

const failing: CollaborationStorage = {
  ...new InMemoryCollaborationStorage(),
  async saveDocument() {
    throw new Error('connection terminated unexpectedly');
  },
} as unknown as CollaborationStorage;

afterEach(() => {
  setCollaborationLogger(undefined);
});

describe('storage failures are surfaced', () => {
  it('reports a failed persist from onStoreDocument', async () => {
    const driver = new YjsDriver({ authorize: allow, storage: failing });
    const document = new Y.Doc();

    const events = await captured(async () => {
      await expect(
        hooksOf(driver).onStoreDocument({ documentName: DOC, document }),
      ).rejects.toThrow(/connection terminated/);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'storage',
      operation: 'saveDocument',
      docName: DOC,
    });

    await driver.close();
  });

  it('reports a failed persist from beforeUnloadDocument — the F5 path', async () => {
    const driver = new YjsDriver({ authorize: allow, storage: failing });
    const document = new Y.Doc();

    const events = await captured(async () => {
      await expect(
        hooksOf(driver).beforeUnloadDocument({ documentName: DOC, document }),
      ).rejects.toThrow(/connection terminated/);
    });

    expect(events.map((event) => event.operation)).toEqual(['saveDocument']);

    await driver.close();
  });

  it('writes to the Adonis logger when one is installed', async () => {
    const error = vi.fn();
    setCollaborationLogger({ error });

    const driver = new YjsDriver({ authorize: allow, storage: failing });
    await expect(
      hooksOf(driver).onStoreDocument({ documentName: DOC, document: new Y.Doc() }),
    ).rejects.toThrow();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ scope: 'storage', docName: DOC });
    expect(String(error.mock.calls[0]![1])).toContain('storage.saveDocument failed');

    await driver.close();
  });

  it('says nothing when the save succeeds', async () => {
    const driver = new YjsDriver({ authorize: allow, storage: new InMemoryCollaborationStorage() });

    const events = await captured(async () => {
      await hooksOf(driver).onStoreDocument({ documentName: DOC, document: new Y.Doc() });
    });

    expect(events).toEqual([]);

    await driver.close();
  });
});

describe('a denial and an outage are different answers at the handshake', () => {
  const payload = { documentName: DOC, token: token('u_1'), connectionConfig: { readOnly: false } };

  it('denies with CollabForbiddenError, and reports nothing', async () => {
    const driver = new YjsDriver({ authorize: deny, storage: new InMemoryCollaborationStorage() });

    let thrown: unknown;
    const events = await captured(async () => {
      await hooksOf(driver)
        .onAuthenticate(payload)
        .catch((error: unknown) => {
          thrown = error;
        });
    });

    expect(thrown).toBeInstanceOf(CollabForbiddenError);
    // A denial is an answer, not a fault: nothing to alert on.
    expect(events).toEqual([]);

    await driver.close();
  });

  it('reports a broken rule as CollabAuthorizationError, not as a denial', async () => {
    const driver = new YjsDriver({
      authorize: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432');
      },
      storage: new InMemoryCollaborationStorage(),
    });

    let thrown: unknown;
    const events = await captured(async () => {
      await hooksOf(driver)
        .onAuthenticate(payload)
        .catch((error: unknown) => {
          thrown = error;
        });
    });

    expect(thrown).toBeInstanceOf(CollabAuthorizationError);
    expect(thrown).not.toBeInstanceOf(CollabForbiddenError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: 'authorize', operation: 'onAuthenticate' });
    expect((events[0]!.error as Error).message).toContain('ECONNREFUSED');

    await driver.close();
  });

  it('binds the connection read-only when the rule grants read but not write', async () => {
    const driver = new YjsDriver({
      authorize: async () => ({ canRead: true, canWrite: false, canComment: true }),
      storage: new InMemoryCollaborationStorage(),
    });

    const connectionConfig = { readOnly: false };
    await hooksOf(driver).onAuthenticate({ ...payload, connectionConfig });
    expect(connectionConfig.readOnly).toBe(true);

    await driver.close();
  });
});
