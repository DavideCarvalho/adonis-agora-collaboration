import type { WebSocket } from 'ws';
import type { CollabTokenSecret } from './auth/secret.js';
import type { AuthorizeFn } from './auth/token.js';
import type { CollabDocumentSeed } from './documents.js';
import type {
  CollabComment,
  CollabConnectionContext,
  CollabDiffSummary,
  CollaborationConfig,
  CollaborationStorage,
  CollabPermission,
  CollabVersion,
  PartyKitConfig,
} from './types.js';

/**
 * Contract for a CRDT driver. The driver owns the engine (Yjs/Hocuspocus or
 * Automerge): it receives the Adonis HTTP server to attach the WebSocket,
 * speaks the engine's binary protocol with clients and implements version
 * control (native in Automerge, via snapshots in Yjs).
 */
export interface CollaborationDriver {
  readonly engine: string;

  /** Attaches the WebSocket transport to the HTTP server (upgrade on the configured path). */
  attach(server: import('node:http').Server): Promise<void>;

  /** Current binary state of the document (for external export/push, e.g. Drive). */
  getDocumentState(docName: string): Promise<Uint8Array>;

  /** Plain text of the document (for LanguageTool, RAG, comment indexes). */
  getDocumentText(docName: string): Promise<string>;

  /** Creates a named version in the history. */
  createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion>;

  /** Lists the versions in the history. */
  listVersions(docName: string): Promise<CollabVersion[]>;

  /** Restores the document to a version (creates a new "restored from X" version). */
  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void>;

  /** Diff summary between two versions. */
  diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary>;

  /**
   * Binary state stored for one version — what `getDocumentState` is to the
   * present, this is to a point in the history. Apps that already read the
   * live state to export it (text extraction, a push to Drive) need the same
   * for "the document as it was at version X"; without it on the contract
   * they reached in through a cast, which is how a private method becomes a
   * de-facto public one that nobody may rename.
   */
  getVersionState(docName: string, versionId: string): Promise<Uint8Array>;

  /** Gracefully shuts down (flush + closes connections). */
  close(): Promise<void>;
}

/**
 * Drivers that keep the document alive **in this process** and can hand the
 * instance over for direct work.
 *
 * Optional on the driver contract on purpose: a `partykit` document lives on
 * the edge and there is no in-process instance to give, so the engine says so
 * by not implementing this rather than by returning a convincing fake. Ask
 * with {@link supportsLiveDocuments} instead of casting — the manager routes
 * by document name and only learns the engine afterwards.
 *
 * The document is Yjs's own type, not a wrapper. Everything a caller comes
 * here for — merging an external change into what is on screen, reading the
 * text without waiting for a flush — is a `transact()` that has to fan out to
 * the connected clients, and a wrapper around that would only be a worse
 * `Y.Doc`. The engine leaks here because this IS the engine-specific seam;
 * the manager stays engine-agnostic by asking whether the seam exists.
 */
export interface LiveDocumentDriver {
  /** The live document, or `undefined` when nobody has it open here. */
  liveDocument(docName: string): import('yjs').Doc | undefined;
}

/** Whether this driver keeps live in-process documents ({@link LiveDocumentDriver}). */
export function supportsLiveDocuments(
  driver: CollaborationDriver,
): driver is CollaborationDriver & LiveDocumentDriver {
  return typeof (driver as Partial<LiveDocumentDriver>).liveDocument === 'function';
}

/** Narrow dependencies for self-hosted engines (Yjs/Automerge). */
import type { PresenceService } from './services/presence_service.js';

export interface SelfHostedDriverOptions {
  storage?: CollaborationStorage;
  authorize: AuthorizeFn;
  /**
   * Key the handshake verifies tokens against — the same one the issuer
   * signs with, resolved through `auth/secret.ts`.
   *
   * Required, and deliberately not optional: a driver built without it would
   * have to choose between refusing every connection and accepting unsigned
   * ones, and the second choice is the vulnerability this replaced (an
   * unauthenticated client sending `base64({"userId":"<victim>"})` was
   * authorized as that user). The manager passes a resolver that reads the
   * app key, so an app configures nothing.
   */
  tokenSecret: CollabTokenSecret;
  path?: string;
  debounce?: number;
  /** Alimenta presença server-side (cross-instance) no connect/disconnect. */
  presence?: PresenceService;
  /**
   * Initial content for a document the storage has never stored — the manager
   * resolves it from the matching `documents` declaration's `load`. The driver
   * asks once, when it is about to open an empty document, and persists what
   * it gets back before serving it.
   */
  seedDocument?: (docName: string) => Promise<CollabDocumentSeed>;
}

/** Narrow dependencies for the edge engine (PartyKit). */
export interface PartyKitDriverOptions {
  storage?: CollaborationStorage;
  partykit: PartyKitConfig;
}

/** Helpers shared across drivers. */
export type {
  CollabComment,
  CollabConnectionContext,
  CollabDiffSummary,
  CollaborationConfig,
  CollabPermission,
  CollabVersion,
};
