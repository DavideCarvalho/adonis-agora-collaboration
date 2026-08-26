import type { CollaborationDriver } from './driver.js';
import { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
import { PartyKitDriver } from './drivers/partykit/partykit_driver.js';
import { resolveStorage } from './drivers/shared.js';
import { YjsDriver } from './drivers/yjs/yjs_driver.js';
import { CommentService } from './services/comment_service.js';
import type { CollabDiffSummary, CollabVersion, CollaborationConfig } from './types.js';

/**
 * Library facade: picks the driver for the configured engine and exposes the
 * unified API (documents + versions + comments) to the host app.
 *
 * Seams:
 *  - drivers connect only through the registry below;
 *  - comments live exclusively here (`manager.comments`) — drivers never
 *    touch them;
 *  - presence is owned by each engine at runtime (edge worker awareness or
 *    client-side), not by this process.
 */
export class CollaborationManager {
  private driver: CollaborationDriver;
  comments: CommentService;

  constructor(private config: CollaborationConfig) {
    const engine = config.engine ?? 'yjs';
    const storage = config.storage;

    if (engine === 'partykit') {
      this.driver = new PartyKitDriver({
        ...(storage ? { storage } : {}),
        partykit: config.partykit!,
      });
    } else {
      const shared = {
        authorize: config.authorize,
      };
      const opts = {
        ...shared,
        ...(storage ? { storage } : {}),
        ...(config.path !== undefined ? { path: config.path } : {}),
        ...(config.debounce !== undefined ? { debounce: config.debounce } : {}),
      };
      this.driver = engine === 'automerge' ? new AutomergeDriver(opts) : new YjsDriver(opts);
    }

    // Single comments seam — one service, one storage instance.
    this.comments = new CommentService(resolveStorage(storage));
  }

  get engine(): string {
    return this.driver.engine;
  }

  /** Attaches the driver's WebSocket to the Adonis HTTP server. No-op on edge. */
  async attach(server: import('node:http').Server): Promise<void> {
    await this.driver.attach(server);
  }

  /** Current binary state (for external push — Google Drive, export...). */
  getDocumentState(docName: string): Promise<Uint8Array> {
    return this.driver.getDocumentState(docName);
  }

  /** Plain text (LanguageTool, RAG, comment indexes). */
  getDocumentText(docName: string): Promise<string> {
    return this.driver.getDocumentText(docName);
  }

  createVersion(
    docName: string,
    createdBy: string | null,
    label?: string | null,
  ): Promise<CollabVersion> {
    return this.driver.createVersion(docName, createdBy, label ?? null);
  }

  listVersions(docName: string): Promise<CollabVersion[]> {
    return this.driver.listVersions(docName);
  }

  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void> {
    return this.driver.restoreVersion(docName, versionId, restoredBy);
  }

  diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    return this.driver.diffVersions(docName, aId, bId);
  }

  /**
   * Persists an external snapshot (e.g. PartyKit worker post-debounce).
   * Requires a configured storage backend.
   */
  async persistDocument(docName: string, state: Uint8Array): Promise<void> {
    if (!this.config.storage) {
      throw new Error(
        'persistDocument requires a storage backend — configure storage in config/collaboration.ts',
      );
    }
    await this.config.storage.saveDocument(docName, state);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export { YjsDriver, AutomergeDriver, PartyKitDriver };
export type { CollaborationConfig, CollaborationDriver };
