import type { CollaborationConfig } from './types.js';

export { CollaborationManager } from './collaboration_manager.js';
export { YjsDriver } from './drivers/yjs/yjs_driver.js';
export { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
export { PresenceService, type PresenceMember } from './services/presence_service.js';
export type {
  CollaborationEngine,
  CollaborationConfig,
  CollaborationStorage,
  CollabConnectionContext,
  CollabPermission,
  CollabVersion,
  CollabDiffSummary,
} from './types.js';

/** Config helper (type-safe) usado no `config/collaboration.ts` do app. */
export function defineConfig(config: CollaborationConfig): CollaborationConfig {
  return config;
}
