import type { CollaborationDriver, SelfHostedDriverOptions } from './driver.js';
import { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
import { PartyKitDriver } from './drivers/partykit/partykit_driver.js';
import { resolveStorage } from './drivers/shared.js';
import { YjsDriver } from './drivers/yjs/yjs_driver.js';
import { CommentService } from './services/comment_service.js';
import type {
  CollabDiffSummary,
  CollabVersion,
  CollaborationConfig,
  CollaborationEngine,
} from './types.js';

/**
 * Library facade. Each document resolves to an engine (per-doc via
 * `config.engineFor`, default `config.engine`) and a driver instance per
 * engine is built lazily on first use. Self-hosted drivers attach their
 * WebSocket to the HTTP server the first time a document uses them.
 */
export class CollaborationManager {
  private readonly config: CollaborationConfig;
  private readonly drivers = new Map<CollaborationEngine, CollaborationDriver>();
  private server?: import('node:http').Server;
  comments: CommentService;

  constructor(config: CollaborationConfig) {
    this.config = config;
    this.comments = new CommentService(resolveStorage(config.storage));
    // Default engine is materialized eagerly so `engine` and boot-time attach
    // behave exactly as before.
    this.#driverFor(config.engine ?? 'yjs');
  }

  /** Engine a document belongs to (per-doc resolver, else default). */
  async engineFor(docName: string): Promise<CollaborationEngine> {
    if (this.config.engineFor) return this.config.engineFor(docName);
    return this.config.engine ?? 'yjs';
  }

  get engine(): string {
    return this.config.engine ?? 'yjs';
  }

  #buildDriver(engine: CollaborationEngine): CollaborationDriver {
    const storage = this.config.storage;
    if (engine === 'partykit' || engine === 'partyserver') {
      return new PartyKitDriver({
        ...(storage ? { storage } : {}),
        partykit: this.config.partykit!,
      });
    }
    const shared: SelfHostedDriverOptions = {
      authorize: this.config.authorize,
      ...(storage ? { storage } : {}),
      ...(this.config.path !== undefined ? { path: this.config.path } : {}),
      ...(this.config.debounce !== undefined ? { debounce: this.config.debounce } : {}),
    };
    return engine === 'automerge' ? new AutomergeDriver(shared) : new YjsDriver(shared);
  }

  async #driverFor(docName: string): Promise<CollaborationDriver> {
    const engine = await this.engineFor(docName);
    return this.#driverByEngine(engine);
  }

  async #driverByEngine(engine: CollaborationEngine): Promise<CollaborationDriver> {
    let driver = this.drivers.get(engine);
    if (!driver) {
      driver = this.#buildDriver(engine);
      this.drivers.set(engine, driver);
      // Late-joined self-hosted drivers still mount their WS on the running
      // server; the upgrade handler is simply registered now.
      if (this.server && (engine === 'yjs' || engine === 'automerge')) {
        await driver.attach(this.server);
      }
    }
    return driver;
  }

  /** Attaches the WebSocket(s) to the Adonis HTTP server. No-op on edge. */
  async attach(server: import('node:http').Server): Promise<void> {
    this.server = server;
    // Only self-hosted engines expose a WS to mount at boot.
    for (const engine of ['yjs', 'automerge'] as const) {
      if (this.drivers.has(engine)) {
        await this.drivers.get(engine)!.attach(server);
      }
    }
  }

  getDocumentState(docName: string): Promise<Uint8Array> {
    return this.#driverFor(docName).then((driver) => driver.getDocumentState(docName));
  }

  getDocumentText(docName: string): Promise<string> {
    return this.#driverFor(docName).then((driver) => driver.getDocumentText(docName));
  }

  createVersion(
    docName: string,
    createdBy: string | null,
    label?: string | null,
  ): Promise<CollabVersion> {
    return this.#driverFor(docName).then((driver) =>
      driver.createVersion(docName, createdBy, label ?? null),
    );
  }

  listVersions(docName: string): Promise<CollabVersion[]> {
    return this.#driverFor(docName).then((driver) => driver.listVersions(docName));
  }

  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void> {
    return this.#driverFor(docName).then((driver) =>
      driver.restoreVersion(docName, versionId, restoredBy),
    );
  }

  diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    return this.#driverFor(docName).then((driver) => driver.diffVersions(docName, aId, bId));
  }

  /** Persists an external snapshot (e.g. PartyKit worker post-debounce). */
  async persistDocument(docName: string, state: Uint8Array): Promise<void> {
    if (!this.config.storage) {
      throw new Error(
        'persistDocument requires a storage backend — configure storage in config/collaboration.ts',
      );
    }
    await this.config.storage.saveDocument(docName, state);
  }

  async close(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((driver) => driver.close()));
  }
}

export { YjsDriver, AutomergeDriver, PartyKitDriver };
export type { CollaborationConfig, CollaborationDriver };
