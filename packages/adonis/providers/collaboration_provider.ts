import type { ApplicationService } from '@adonisjs/core/types';
import { CollaborationManager } from '../src/collaboration_manager.js';
import type { CollaborationAppConfig } from '../src/define_config.js';
import { setBootedApp } from '../src/services/booted_app.js';
import type {
  CollabConnectionContext,
  CollabPermission,
  CollaborationConfig,
} from '../src/types.js';

/**
 * Wires `@adonis-agora/collaboration` into the AdonisJS application:
 *
 * - `register()` hands the booted app to `services/main` and binds the
 *   `CollaborationManager` singleton from `config/collaboration.ts`;
 * - `boot()` attaches the collaboration WebSocket upgrade to the Adonis HTTP
 *   server (path from config, default `/collaboration`);
 * - `shutdown()` flushes pending stores and closes all connections.
 */
export default class CollaborationServiceProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    // Hand the booted app to `services/main` so its eager population reads the SAME @adonisjs/core
    // copy bin/server booted, never a pnpm-split non-booted one (see services/booted_app.ts).
    setBootedApp(this.app);

    const config = this.app.config.get<CollaborationAppConfig>('collaboration');

    this.app.container.singleton(CollaborationManager, () => {
      if (!config?.authorize) {
        throw new Error(
          'Configure authorize() em config/collaboration.ts — a lib nunca autoriza por padrão',
        );
      }

      const managerConfig: CollaborationConfig = {
        engine: config.engine ?? 'yjs',
        authorize: (ctx: CollabConnectionContext, docName: string): Promise<CollabPermission> =>
          config.authorize(ctx, docName),
        path: config.path ?? '/collaboration',
        debounce: config.debounce ?? 2000,
      };

      if (config.storage) {
        managerConfig.storage = config.storage;
      }
      if (config.redisUrl) {
        managerConfig.redis = { url: config.redisUrl };
      }

      return new CollaborationManager(managerConfig);
    });
  }

  async boot() {
    const manager = await this.app.container.make(CollaborationManager);

    // O HttpServerService do Adonis expõe o Server node cru via getInstance()
    // (é assim que integrações WebSocket se anexam ao processo principal).
    const httpServer = await this.app.container.make('server');
    const nodeServer = (
      httpServer as unknown as { getInstance(): import('node:http').Server }
    ).getInstance();

    await manager.attach(nodeServer);
  }

  async shutdown() {
    const manager = await this.app.container.make(CollaborationManager);
    await manager.close();
  }
}
