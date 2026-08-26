import type { ApplicationService } from '@adonisjs/core/types';
import { Redis } from 'ioredis';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollaborationAppConfig } from '../src/define_config.js';
import { collaborationRoutes } from '../src/routes.js';
import { setBootedApp } from '../src/services/booted_app.js';
import { RedisPresenceStore } from '../src/services/presence_service.js';

/**
 * Wires `@adonis-agora/collaboration` into the AdonisJS application:
 *
 * - `register()` hands the booted app to `services/main` and binds the
 *   `CollaborationManager` singleton from `config/collaboration.ts`;
 * - `boot()`/`ready()` attaches the collaboration WebSocket upgrade to the
 *   Adonis HTTP server (path from config, default `/collaboration`);
 * - `ready()` registers the built-in REST endpoints automatically unless
 *   `routes.enabled: false` — then call `collaborationRoutes(router)` in
 *   `start/routes.ts` with your own middleware;
 * - `shutdown()` flushes pending stores and closes all connections.
 */
export default class CollaborationServiceProvider {
  private config?: CollaborationAppConfig;

  constructor(protected app: ApplicationService) {}

  register() {
    // Hand the booted app to `services/main` so its eager population reads the SAME @adonisjs/core
    // copy bin/server booted, never a pnpm-split non-booted one (see services/booted_app.ts).
    setBootedApp(this.app);

    const config = this.app.config.get<CollaborationAppConfig>('collaboration');
    this.config = config;

    this.app.container.singleton(CollaborationManager, () => {


      const presenceStore =
        config.redisUrl && config.redisUrl.length > 0
          ? new RedisPresenceStore(new Redis(config.redisUrl))
          : undefined;

      const managerConfig = {
        engine: config.engine ?? 'yjs',
        ...(config.engineFor ? { engineFor: config.engineFor } : {}),
        ...(config.authorize ? { authorize: config.authorize } : {}),
        path: config.path ?? '/collaboration',
        debounce: config.debounce ?? 2000,
        ...(config.storage ? { storage: config.storage } : {}),
        ...(config.redisUrl ? { redis: { url: config.redisUrl } } : {}),
        ...(config.partykit ? { partykit: config.partykit } : {}),
      };

      return new CollaborationManager(managerConfig, presenceStore);
    });
  }

  async ready() {
    // Attach happens in `ready()` (lifecycle phase 4): Ignitor created the
    // node HTTP server during `start()` (phase 3), so getNodeServer() exists.
    // Outside the web process (ace/console/test/repl) there is no HTTP
    // server — collaboration does not start; the manager stays available.
    const env = this.app.getEnvironment() as string;
    if (env !== 'web') {
      return;
    }

    const manager = await this.app.container.make(CollaborationManager);

    const adonisServer = (await this.app.container.make('server')) as {
      getNodeServer?(): import('node:http').Server | undefined;
    };

    const nodeServer = adonisServer.getNodeServer?.();
    if (!nodeServer) {
      throw new Error(
        '[@adonis-agora/collaboration] getNodeServer() unavailable in ready() — check @adonisjs/http-server version',
      );
    }

    await manager.attach(nodeServer);

    // Auto-register built-in REST endpoints unless explicitly disabled.
    const routes = this.config?.routes;
    if (routes?.enabled === false) {
      return;
    }

    const router = (await this.app.container.make('router')) as Parameters<
      typeof collaborationRoutes
    >[0];

    const runtimeOptions: Parameters<typeof collaborationRoutes>[1] = {
      managerFallback: () => this.app.container.make(CollaborationManager),
    };
    if (routes?.prefix !== undefined) runtimeOptions.prefix = routes.prefix;
    if (routes?.middleware !== undefined) runtimeOptions.middleware = routes.middleware;
    if (routes?.resolveUser !== undefined) runtimeOptions.resolveUser = routes.resolveUser;
    if (this.config?.authorize !== undefined) runtimeOptions.authorize = this.config.authorize;

    await collaborationRoutes(router, runtimeOptions);
  }

  async shutdown() {
    const manager = await this.app.container.make(CollaborationManager);
    await manager.close();
  }
}
