import type { WebSocket } from 'ws';
import type { AuthorizeFn } from './auth/token.js';
import type {
  CollabComment,
  CollabConnectionContext,
  CollabDiffSummary,
  CollabPermission,
  CollabVersion,
  CollaborationConfig,
  CollaborationStorage,
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

  /** Gracefully shuts down (flush + closes connections). */
  close(): Promise<void>;
}

/** Narrow dependencies for self-hosted engines (Yjs/Automerge). */
export interface SelfHostedDriverOptions {
  storage?: CollaborationStorage;
  authorize: AuthorizeFn;
  path?: string;
  debounce?: number;
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
  CollabPermission,
  CollabVersion,
  CollaborationConfig,
};
export type { CollabDiffSummary };
