export { CollaborationManager } from './collaboration_manager.js';
export { YjsDriver } from './drivers/yjs/yjs_driver.js';
export { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
export {
  PartyKitDriver,
  PartyKitRoomError,
} from './drivers/partykit/partykit_driver.js';
export {
  buildWsUrl,
  CollabForbiddenError,
  issueToken,
  parseLegacyToken,
  signPartyKitToken,
  verifyPartyKitToken,
  type AuthorizeFn,
  type IssuedToken,
  type TokenIssuerConfig,
} from './auth/token.js';
export { LucidStorage, lucidStorage } from './storage/lucid_storage.js';
export {
  PresenceService,
  RedisPresenceStore,
  type PresenceMember,
  type PresenceStore,
} from './services/presence_service.js';
export { InMemoryCollaborationStorage } from './storage/in_memory_storage.js';
export { FileSystemStorage } from './storage/file_system_storage.js';
export {
  defineConfig,
  type CollaborationAppConfig,
} from './define_config.js';
export { collaborationRoutes, defaultResolveUser, secretsMatch } from './routes.js';
export type {
  CollabHttpContext,
  CollabManagerLike,
  CollabRouteUser,
  CollabRoutesRuntime,
  ResolveUserFn,
} from './http/types.js';
export { CollabUnauthorizedError } from './http/types.js';
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
  PartyKitConfig,
  PruneVersionsOptions,
} from './types.js';

// Root-level export so `node ace configure @adonis-agora/collaboration`
// finds the hook without hitting the ./configure subpath.
export { configure } from '../configure.js';
export { defineDocument, matchDocumentPattern } from './documents.js';
export type { CollabDocumentDeclaration } from './documents.js';
