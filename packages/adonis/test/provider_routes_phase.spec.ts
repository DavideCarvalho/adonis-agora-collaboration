import { describe, expect, it } from 'vitest';
import CollaborationServiceProvider from '../providers/collaboration_provider.js';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollaborationAppConfig } from '../src/define_config.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';

/**
 * The routes have to be registered in the window the router still accepts
 * them.
 *
 * `Server.boot()` calls `router.commit()`, which drains the pending list and
 * flips `#commited`; anything registered afterwards never reaches the route
 * store. The provider used to register in `ready()` — after `start()`, and
 * therefore after the commit — so `/collaboration/*` answered 404 in a
 * production build while looking perfectly configured from the config file.
 *
 * The WebSocket attach is the opposite constraint and must NOT move: the node
 * HTTP server only exists from `start()` onwards, so it belongs in `ready()`.
 * This test drives the real lifecycle order and pins both.
 */

/** A router with the one behaviour that matters: commit() closes the door. */
function makeRouter() {
  const pending: string[] = [];
  const store: string[] = [];
  const orphaned: string[] = [];
  let committed = false;

  const record = (method: string) => (pattern: string, _handler: unknown) => {
    const route = `${method} ${pattern}`;
    if (committed) {
      // Exactly what Adonis does with a late route: nothing.
      orphaned.push(route);
      return;
    }
    pending.push(route);
  };

  const group = {
    prefix(prefix: string) {
      for (let index = 0; index < pending.length; index++) {
        const [method, pattern] = pending[index]!.split(' ') as [string, string];
        pending[index] = `${method} ${prefix}${pattern}`;
      }
      return group;
    },
    middleware() {
      return group;
    },
  };

  const router = {
    group(callback: () => void) {
      callback();
      return group;
    },
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  };

  return {
    router,
    store,
    orphaned,
    get committed() {
      return committed;
    },
    /** What `Server.boot()` does during `app.start()`. */
    commit() {
      store.push(...pending.splice(0));
      committed = true;
    },
  };
}

function makeApp(config: CollaborationAppConfig, environment: string, router: unknown) {
  const factories = new Map<unknown, () => unknown>();
  const cache = new Map<unknown, unknown>();
  const upgrades: unknown[] = [];
  const nodeServer = {
    on(event: string, handler: unknown) {
      upgrades.push([event, handler]);
    },
  };

  const app = {
    config: { get: () => config },
    getEnvironment: () => environment,
    container: {
      singleton(binding: unknown, resolver: () => unknown) {
        factories.set(binding, resolver);
      },
      async make(binding: unknown): Promise<unknown> {
        if (binding === 'router') return router;
        if (binding === 'server') return { getNodeServer: () => nodeServer };
        if (binding === 'logger') throw new Error('no logger bound');
        if (!cache.has(binding)) {
          const factory = factories.get(binding);
          if (!factory) throw new Error(`unbound: ${String(binding)}`);
          cache.set(binding, factory());
        }
        return cache.get(binding);
      },
    },
  };

  return { app, upgradeHandlers: upgrades };
}

const config: CollaborationAppConfig = {
  engine: 'yjs',
  storage: new InMemoryCollaborationStorage(),
  authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
};

describe('provider route registration phase', () => {
  it('registers the REST routes before the router commits', async () => {
    const router = makeRouter();
    const { app } = makeApp(config, 'web', router.router);
    const provider = new CollaborationServiceProvider(app as never);

    provider.register();
    await provider.boot();

    // The commit is what Server.boot() runs during app.start(), i.e. AFTER
    // every provider's boot() and BEFORE any ready().
    expect(router.committed).toBe(false);
    router.commit();

    expect(router.store).toContain('GET /collaboration/token');
    expect(router.store).toContain('POST /collaboration/versions/restore');
    expect(router.store).toHaveLength(10);
    expect(router.orphaned).toEqual([]);

    await provider.shutdown();
  });

  it('registers nothing after the commit, and still attaches the WebSocket in ready()', async () => {
    const router = makeRouter();
    const { app, upgradeHandlers } = makeApp(config, 'web', router.router);
    const provider = new CollaborationServiceProvider(app as never);

    provider.register();
    await provider.boot();
    router.commit();
    await provider.ready();

    // Nothing tried to register late — a route registered here is a route
    // the app will answer 404 for.
    expect(router.orphaned).toEqual([]);
    // ...and the socket upgrade, which genuinely needs the node server, is
    // still wired in ready().
    expect(upgradeHandlers.map(([event]) => event)).toEqual(['upgrade']);

    await provider.shutdown();
  });

  it('honours routes.enabled: false', async () => {
    const router = makeRouter();
    const { app } = makeApp({ ...config, routes: { enabled: false } }, 'web', router.router);
    const provider = new CollaborationServiceProvider(app as never);

    provider.register();
    await provider.boot();
    router.commit();

    expect(router.store).toEqual([]);

    await provider.shutdown();
  });
});
