import { resolveTokenSecret } from './auth/secret.js';
import type { CollabDocumentSeed } from './documents.js';
import { documentPatternParams, matchDocumentPattern } from './documents.js';
import type { CollaborationDriver, SelfHostedDriverOptions } from './driver.js';
import { supportsLiveDocuments } from './driver.js';
import { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
import { PartyKitDriver } from './drivers/partykit/partykit_driver.js';
import { resolveStorage } from './drivers/shared.js';
import { YjsDriver } from './drivers/yjs/yjs_driver.js';
import { reportCollaborationWarning } from './observability.js';
import { CommentService } from './services/comment_service.js';
import {
  type PresenceMember,
  PresenceService,
  type PresenceStore,
} from './services/presence_service.js';
import type {
  CollabConnectionContext,
  CollabDiffSummary,
  CollaborationConfig,
  CollaborationEngine,
  CollabPermission,
  CollabVersion,
  LiveDocumentResult,
  PruneVersionsOptions,
} from './types.js';

/**
 * Library facade. Each document resolves to an engine (per-doc via
 * `config.engineFor`, default `config.engine`) and a driver instance per
 * engine is built lazily on first use. Self-hosted drivers attach their
 * WebSocket to the HTTP server the first time a document uses them.
 */
/**
 * A pattern without a `:segment` matches exactly one document — almost never
 * what a `documents` entry means. Say so once, at boot, with the fix.
 */
function warnAboutSingleDocumentPatterns(documents: CollaborationConfig['documents']): void {
  for (const pattern of Object.keys(documents ?? {})) {
    if (documentPatternParams(pattern).length > 0) continue;
    reportCollaborationWarning(
      { pattern },
      `document pattern "${pattern}" has no ":param" segment, so it matches exactly one document ` +
        `named "${pattern}" — not "${pattern}/<id>". If it is a collection, declare ` +
        `"${pattern}/:id" or use defineCollection("${pattern}", …).`,
    );
  }
}

export class CollaborationManager {
  private readonly config: CollaborationConfig;
  private tokenSecretPromise: Promise<string> | undefined;
  private readonly drivers = new Map<CollaborationEngine, CollaborationDriver>();
  private server?: import('node:http').Server;
  comments: CommentService;
  presence?: PresenceService;

  constructor(config: CollaborationConfig, presenceStore?: PresenceStore) {
    this.config = config;
    warnAboutSingleDocumentPatterns(config.documents);
    this.comments = new CommentService(resolveStorage(config.storage));
    if (presenceStore) {
      this.presence = new PresenceService(presenceStore);
    }
    // Default engine is materialized eagerly so `engine` and boot-time attach
    // behave exactly as before.
    this.#driverFor(config.engine ?? 'yjs');
  }

  /** Engine a document belongs to (per-doc resolver, else default). */
  async engineFor({ docName }: { docName: string }): Promise<CollaborationEngine> {
    if (this.config.engineFor) return this.config.engineFor(docName);
    const declared = this.#documentFor(docName);
    if (declared?.declaration.engine) return declared.declaration.engine;
    return this.config.engine ?? 'yjs';
  }

  /** Documento declarado que casa com o docName (pattern match). */
  #documentFor(docName: string): {
    declaration: import('./documents.js').CollabDocumentDeclaration;
    params: Record<string, string>;
  } | null {
    if (!this.config.documents) return null;
    for (const [pattern, declaration] of Object.entries(this.config.documents)) {
      const params = matchDocumentPattern(pattern, docName);
      if (params) return { declaration, params };
    }
    return null;
  }

  /**
   * Resolved authorization for a document: the declared document's own
   * `authorize` when one matches, else the global `authorize`, else deny.
   *
   * Public because the permission seam has to hold on both paths — the
   * WebSocket handshake AND the REST token endpoint issue credentials, and
   * both must resolve the rule the same way.
   */
  async authorize(ctx: CollabConnectionContext, docName: string): Promise<CollabPermission> {
    const declared = this.#documentFor(docName);
    if (declared?.declaration.authorize) {
      return declared.declaration.authorize(ctx, { docName, params: declared.params as never });
    }
    if (this.config.authorize) return this.config.authorize(ctx, docName);
    return { canRead: false, canWrite: false, canComment: false };
  }

  /**
   * Initial content for a document nothing has stored yet: the matched
   * declaration's `load`, or nothing.
   *
   * Resolved here, next to `authorize`, because both answers come from the
   * same declaration and the same pattern match — a driver that had to find
   * the declaration itself would be a second matcher to keep in step with the
   * first. Private: the drivers ask, at the one moment the answer is usable.
   */
  async #seedFor(docName: string): Promise<CollabDocumentSeed> {
    const declared = this.#documentFor(docName);
    if (!declared?.declaration.load) return undefined;
    return declared.declaration.load({ docName, params: declared.params as never });
  }

  get engine(): string {
    return this.config.engine ?? 'yjs';
  }

  /**
   * The key that signs and verifies this app's collaboration tokens.
   *
   * Public for the same reason `authorize` is: the credential has two ends —
   * the REST route that issues it and the WebSocket handshake that checks it
   * — and they must resolve it identically. The routes ask the manager rather
   * than repeating the resolution order, so `tokenSecret` in
   * `config/collaboration.ts` (or on this constructor) applies to both, and
   * neither can silently fall back to a different key.
   *
   * Memoized on the promise rather than the value, so two documents opening
   * at once share one read of the app config instead of racing it.
   */
  tokenSecret(): Promise<string> {
    if (!this.tokenSecretPromise) {
      const resolving = resolveTokenSecret(this.config.tokenSecret);
      this.tokenSecretPromise = resolving;
      // The failure is never memoized — a manager built before the app
      // finished booting has no app key to read yet, and remembering that as
      // "there is no key" would outlive the condition that caused it. The
      // handler also keeps the rejection from surfacing as unhandled; every
      // caller still sees it through the promise this returns.
      void resolving.catch(() => {
        this.tokenSecretPromise = undefined;
      });
    }
    return this.tokenSecretPromise;
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
      authorize: (ctx, docName) => this.authorize(ctx, docName),
      // Deferred, not resolved here: the default key is the app's `appKey`,
      // and drivers are built before the app is necessarily booted. Passing
      // the same accessor the token route uses is what keeps the two ends of
      // the credential on one source — sign with one key and verify with
      // another and every handshake fails with nothing to point at.
      tokenSecret: () => this.tokenSecret(),
      seedDocument: (docName) => this.#seedFor(docName),
      ...(storage ? { storage } : {}),
      // Without this the presence store the provider builds from `redisUrl`
      // is never reached: the drivers' join/leave both guard on
      // `options.presence`, so `listPresence()` answered [] forever.
      ...(this.presence ? { presence: this.presence } : {}),
      ...(this.config.path !== undefined ? { path: this.config.path } : {}),
      ...(this.config.debounce !== undefined ? { debounce: this.config.debounce } : {}),
    };
    return engine === 'automerge' ? new AutomergeDriver(shared) : new YjsDriver(shared);
  }

  async #driverFor(docName: string): Promise<CollaborationDriver> {
    const engine = await this.engineFor({ docName });
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

  getDocumentState({ docName }: { docName: string }): Promise<Uint8Array> {
    return this.#driverFor(docName).then((driver) => driver.getDocumentState(docName));
  }

  getDocumentText({ docName }: { docName: string }): Promise<string> {
    return this.#driverFor(docName).then((driver) => driver.getDocumentText(docName));
  }

  /**
   * Runs `run` against the **live** document — the in-process CRDT instance
   * the connected clients are syncing with — and says whether there was one.
   *
   * `getDocumentState` answers with a copy, which is enough to export a
   * document and not enough to change one: an external edit (a Drive webhook,
   * a cron) has to land in the instance people are typing into, or it either
   * loses the keystrokes since the last flush or is lost by them. So this is
   * scoped rather than a getter — the document is only borrowed for the
   * duration of `run`, and a caller cannot stash a `Y.Doc` that Hocuspocus
   * will unload out from under it.
   *
   * The callback gets the engine's real document, deliberately. The manager
   * is engine-agnostic everywhere it routes; here it hands over the one thing
   * a wrapper could not replace (`transact()` that fans out to clients), and
   * keeps its agnosticism by *asking* whether the engine has such a document
   * instead of assuming it: a PartyKit document lives on the edge and comes
   * back `{ live: false, reason: 'engine-has-no-live-document' }` with the
   * callback never run, not a cast that explodes.
   *
   * @example
   * const result = await collaboration.current.withLiveDocument({
   *   docName,
   *   run: (doc) => {
   *     doc.transact(() => applyExternalChange(doc))
   *     return doc.getXmlFragment('default').toString()
   *   },
   * })
   * if (!result.live) await mergeIntoStorageInstead()
   */
  async withLiveDocument<T>({
    docName,
    run,
  }: {
    docName: string;
    run: (document: import('yjs').Doc) => T | Promise<T>;
  }): Promise<LiveDocumentResult<T>> {
    const driver = await this.#driverFor(docName);
    if (!supportsLiveDocuments(driver)) {
      return { live: false, reason: 'engine-has-no-live-document' };
    }
    const document = driver.liveDocument(docName);
    if (!document) return { live: false, reason: 'not-loaded' };
    return { live: true, value: await run(document) };
  }

  /**
   * Whether this process is holding the document open right now.
   *
   * The cheap question on its own, for callers deciding *where* to write
   * before they know what to write. It is a snapshot of a live fact — the
   * last client can disconnect a millisecond later — so anything that then
   * touches the document should go through {@link withLiveDocument} and read
   * its `live` flag rather than trusting this answer.
   */
  async hasLiveDocument({ docName }: { docName: string }): Promise<boolean> {
    const driver = await this.#driverFor(docName);
    return supportsLiveDocuments(driver) && driver.liveDocument(docName) !== undefined;
  }

  createVersion({
    docName,
    createdBy,
    label = null,
  }: {
    docName: string;
    createdBy: string | null;
    label?: string | null;
  }): Promise<CollabVersion> {
    return this.#driverFor(docName).then((driver) =>
      driver.createVersion(docName, createdBy, label),
    );
  }

  listVersions({ docName }: { docName: string }): Promise<CollabVersion[]> {
    return this.#driverFor(docName).then((driver) => driver.listVersions(docName));
  }

  /**
   * Binary state stored for one version — `getDocumentState` for a point in
   * the history. Extracting the text of a version, diffing it against
   * something the library does not know about, exporting it: all of that
   * needs the bytes, and `listVersions` only hands out metadata.
   */
  getVersionState({
    docName,
    versionId,
  }: {
    docName: string;
    versionId: string;
  }): Promise<Uint8Array> {
    return this.#driverFor(docName).then((driver) => driver.getVersionState(docName, versionId));
  }

  restoreVersion({
    docName,
    versionId,
    restoredBy,
  }: {
    docName: string;
    versionId: string;
    restoredBy: string | null;
  }): Promise<void> {
    return this.#driverFor(docName).then((driver) =>
      driver.restoreVersion(docName, versionId, restoredBy),
    );
  }

  diffVersions({
    docName,
    aId,
    bId,
  }: {
    docName: string;
    aId: string;
    bId: string;
  }): Promise<CollabDiffSummary> {
    return this.#driverFor(docName).then((driver) => driver.diffVersions(docName, aId, bId));
  }

  /** Persists an external snapshot (e.g. PartyKit worker post-debounce). */
  async persistDocument({ docName, state }: { docName: string; state: Uint8Array }): Promise<void> {
    if (!this.config.storage) {
      throw new Error(
        'persistDocument requires a storage backend — configure storage in config/collaboration.ts',
      );
    }
    await this.config.storage.saveDocument(docName, state);
  }

  /**
   * Deletes all but the `keep` most recent versions of each document, and
   * returns how many were removed. `keep` is per document — a busy document
   * never evicts another one's history.
   *
   * Meant for a scheduled job; `node ace collaboration:prune` is the same
   * call from the CLI.
   */
  async pruneVersions({ keep, docName, dryRun }: PruneVersionsOptions): Promise<number> {
    if (!this.config.storage) {
      throw new Error(
        '[@adonis-agora/collaboration] pruneVersions requires a storage backend — configure storage in config/collaboration.ts',
      );
    }
    return this.config.storage.pruneVersions({
      keep,
      ...(docName !== undefined ? { docName } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
    });
  }

  /** Online members of a document (across all instances, when Redis set). */
  async listPresence({ docName }: { docName: string }): Promise<PresenceMember[]> {
    return this.presence?.list(docName) ?? [];
  }

  async close(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((driver) => driver.close()));
    await this.presence?.close();
  }
}

export type { CollaborationConfig, CollaborationDriver };
export { AutomergeDriver, PartyKitDriver, YjsDriver };
