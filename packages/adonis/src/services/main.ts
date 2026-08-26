import { CollaborationManager } from '../collaboration_manager.js';
import type { CollaborationAppConfig } from '../define_config.js';
import { whenBootedApp } from './booted_app.js';

/**
 * The singleton {@link CollaborationManager} — populated by
 * `CollaborationProvider` from `config/collaboration.ts`.
 *
 * ```ts
 * import collaboration from '@adonis-agora/collaboration/services/main'
 *
 * const text = await collaboration.getDocumentText('researches/<id>/writing')
 * const version = await collaboration.createVersion(docName, userId, 'before review')
 * ```
 */
let manager: CollaborationManager;

const app = await whenBootedApp();
await app.booted(async () => {
  const config = app.config.get<CollaborationAppConfig>('collaboration', {} as never);
  manager = await app.container.make(CollaborationManager);
  void config;
});

export default {
  get current(): CollaborationManager {
    if (!manager) {
      throw new Error(
        'CollaborationManager has not been initialized yet — wait for the app boot or install the provider',
      );
    }
    return manager;
  },
};
