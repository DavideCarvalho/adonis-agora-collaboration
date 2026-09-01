// Root-level export so `node ace configure @adonis-agora/collaboration`
// finds the hook without hitting the ./configure subpath.
export { configure } from '../configure.js';
export {
  type CollabTokenSecret,
  CollabTokenSecretMissingError,
  resolveTokenSecret,
} from './auth/secret.js';
export {
  type AuthorizeFn,
  buildWsUrl,
  COLLAB_TOKEN_TTL_SECONDS,
  CollabAuthorizationError,
  CollabForbiddenError,
  type CollabTokenPayload,
  type IssuedToken,
  issueToken,
  PARTYKIT_TOKEN_TTL_SECONDS,
  signCollabToken,
  signPartyKitToken,
  type TokenIssuerConfig,
  tokenContext,
  verifyCollabToken,
  verifyPartyKitToken,
  verifySelfHostedToken,
} from './auth/token.js';
export { CollaborationManager } from './collaboration_manager.js';
export {
  type CollabDocumentNameFor,
  type CollabDocuments,
  type CollaborationAppConfig,
  type CollaborationAppConfigFor,
  defineConfig,
  type InferCollabDocumentNames,
} from './define_config.js';
export type {
  CollabDocumentDeclaration,
  CollabDocumentSeed,
  CollectionPattern,
  DocumentParams,
} from './documents.js';
export {
  defineCollection,
  defineDocument,
  documentPatternParams,
  matchDocumentPattern,
} from './documents.js';
export type {
  CollaborationDriver,
  LiveDocumentDriver,
  PartyKitDriverOptions,
  SelfHostedDriverOptions,
} from './driver.js';
export { supportsLiveDocuments } from './driver.js';
export { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
export {
  PartyKitDriver,
  PartyKitRoomError,
} from './drivers/partykit/partykit_driver.js';
export { YjsDriver } from './drivers/yjs/yjs_driver.js';
export type {
  CollabHttpContext,
  CollabManagerLike,
  CollabRoutesRuntime,
  CollabRouteUser,
  ResolveUserFn,
} from './http/types.js';
export { CollabUnauthorizedError } from './http/types.js';
export {
  COLLAB_ERROR_EVENT,
  type CollabErrorEvent,
  type CollabLogger,
  collaborationEvents,
  onCollaborationError,
  reportCollaborationError,
  reportCollaborationWarning,
  setCollaborationLogger,
} from './observability.js';
export {
  canMutateComment,
  collaborationRoutes,
  defaultResolveUser,
  type IssueCollaborationTokenInput,
  type IssueCollaborationTokenOptions,
  issueCollaborationToken,
  secretsMatch,
} from './routes.js';
export {
  type PresenceMember,
  PresenceService,
  type PresenceStore,
  RedisPresenceStore,
} from './services/presence_service.js';
export { FileSystemStorage } from './storage/file_system_storage.js';
export { InMemoryCollaborationStorage } from './storage/in_memory_storage.js';
export { LucidStorage, lucidStorage } from './storage/lucid_storage.js';
export type {
  CollabComment,
  CollabConnectionContext,
  CollabDiffSummary,
  CollaborationConfig,
  CollaborationEngine,
  CollaborationStorage,
  CollabPermission,
  CollabVersion,
  CommentAnchor,
  LiveDocumentAbsence,
  LiveDocumentResult,
  PartyKitConfig,
  PruneVersionsOptions,
} from './types.js';
