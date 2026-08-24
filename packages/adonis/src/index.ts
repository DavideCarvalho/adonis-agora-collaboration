import type { CollaborationConfig } from './types.js';

export { CollaborationManager } from './collaboration_manager.js';
export { YjsDriver } from './drivers/yjs/yjs_driver.js';
export { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
export { CommentService } from './services/comment_service.js';
export { PresenceService, type PresenceMember } from './services/presence_service.js';
export { LucidStorage } from './storage/lucid_storage.js';
export {
  defineConfig,
  type CollaborationAppConfig,
} from './define_config.js';
export type {
  CollabComment,
  CommentAnchor,
  CollaborationEngine,
  CollaborationConfig,
  CollaborationStorage,
  CollabConnectionContext,
  CollabPermission,
  CollabVersion,
  CollabDiffSummary,
} from './types.js';
