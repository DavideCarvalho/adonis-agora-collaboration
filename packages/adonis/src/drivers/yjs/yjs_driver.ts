import type { connectedPayload, onDisconnectPayload } from '@hocuspocus/server';
import {
  Hocuspocus,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
} from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { type RawData, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import {
  CollabAuthorizationError,
  CollabForbiddenError,
  verifySelfHostedToken,
} from '../../auth/token.js';
import type { CollabDocumentSeed } from '../../documents.js';
import type {
  CollaborationDriver,
  LiveDocumentDriver,
  SelfHostedDriverOptions,
} from '../../driver.js';
import { reportCollaborationError } from '../../observability.js';
import type {
  CollabConnectionContext,
  CollabDiffSummary,
  CollaborationStorage,
  CollabPermission,
  CollabVersion,
} from '../../types.js';
import { createVersionMetadata, restoredFromLabel, seqVersions } from '../../versioning.js';
import { lineDiff, resolveStorage, tiptapJsonToText } from '../shared.js';

/**
 * `ws` delivers a frame as a Buffer, a list of Buffers (fragmented frame) or an
 * ArrayBuffer depending on `binaryType`; Hocuspocus wants one `Uint8Array`.
 */
function toUint8Array(data: RawData): Uint8Array {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Yjs driver: Hocuspocus as the sync engine (y-protocols protocol over
 * WebSocket), with version control implemented on top of complete binary
 * updates — what Automerge has natively (history) we provide here:
 *
 *  - `createVersion`: stores the complete binary update + metadata;
 *  - `restoreVersion`: applies the version's content to the live doc via a
 *    transaction — connected clients receive it in real time through the sync
 *    protocol;
 *  - `diffVersions`: materializes both versions and compares them by line.
 *  - Anchored comments: delegate to the CommentService (generic anchor).
 */

export class YjsDriver implements CollaborationDriver, LiveDocumentDriver {
  readonly engine = 'yjs';

  private hocuspocus: Hocuspocus;
  private wss?: WebSocketServer;
  private readonly options: SelfHostedDriverOptions;
  private readonly storage: CollaborationStorage;

  constructor(options: SelfHostedDriverOptions) {
    this.options = options;
    this.storage = resolveStorage(options.storage);

    // Captured outside the callback: `this` inside Hocuspocus hooks is not
    // the driver instance.
    const storage = this.storage;

    /**
     * Presence bookkeeping, keyed by **socket** and scoped to this driver
     * instance.
     *
     * It used to be a module-level `Map<docName, userId>` — one slot per
     * DOCUMENT. A second editor overwrote the first, and then whichever of
     * them disconnected first evicted the other from the roster too. A room
     * is many connections; the map has to be too.
     */
    const presenceBySocket = new Map<string, { documentName: string; userId: string }>();

    /**
     * Seeds in flight, by document name.
     *
     * Hocuspocus already serialises its own `createDocument` per name (it
     * keeps a `loadingDocuments` promise), so two browsers opening the same
     * new document share one load. That is the only caller today, and it is
     * exactly the caller we cannot rely on: `onLoadDocument` is a plain
     * function on the configuration and anything holding the driver can run
     * it. A second seed is not a harmless repeat — two CRDT updates carrying
     * the same paragraph merge into two paragraphs, and the app sees its
     * content duplicated. So the guard lives here too, where the write is.
     *
     * In-flight only, not a memo: once the seed is persisted the storage
     * answers for it, and a `load` that had nothing to give should be asked
     * again the next time the document is opened.
     */
    const seedsInFlight = new Map<string, Promise<Uint8Array | undefined>>();

    const seedDocumentOnce = async (documentName: string): Promise<Uint8Array | undefined> => {
      const seed = options.seedDocument;
      if (!seed) return undefined;

      const inFlight = seedsInFlight.get(documentName);
      if (inFlight) return inFlight;

      const seeding = (async () => {
        let update: Uint8Array | undefined;
        try {
          update = seedUpdate(await seed(documentName));
        } catch (error) {
          // The app's `load` failed. Reported, never rethrown: Hocuspocus
          // turns a throwing onLoadDocument into a closed connection, and a
          // client cannot tell that apart from a denial — it just reconnects,
          // forever, running the failing query again each time.
          reportCollaborationError({
            scope: 'storage',
            operation: 'loadDocument',
            docName: documentName,
            error,
          });
          return undefined;
        }
        if (!update) return undefined;

        // Persisted before it is served, so the hook is a one-off per
        // document instead of a read the app pays for on every connection.
        // It cannot ride on `onStoreDocument`: the seed is applied while the
        // document is still loading, before Hocuspocus subscribes to updates,
        // so nothing marks it dirty and nothing would ever flush it.
        try {
          await storage.saveDocument(documentName, update);
        } catch (error) {
          reportCollaborationError({
            scope: 'storage',
            operation: 'saveDocument',
            docName: documentName,
            error,
          });
        }
        return update;
      })();

      seedsInFlight.set(documentName, seeding);
      try {
        return await seeding;
      } finally {
        seedsInFlight.delete(documentName);
      }
    };

    this.hocuspocus = new Hocuspocus({
      /**
       * The one place identity is established on this transport.
       *
       * The token must be **verified**, not decoded: it used to be a bare
       * base64 of `{ userId }`, so a client with no session at all could send
       * the id of anyone it wanted and be authorized as them. Now the
       * signature, the expiry and the document binding are all checked before
       * `authorize` is asked anything — and `documentName` comes from the
       * connection, so a token minted for one document cannot open another.
       *
       * What it returns becomes the connection's `context` (Hocuspocus merges
       * a hook's resolved value into it), which is how every later hook gets
       * the verified identity instead of re-reading the wire.
       */
      async onAuthenticate({ documentName, token, connectionConfig }: onAuthenticatePayload) {
        let ctx: Awaited<ReturnType<typeof verifySelfHostedToken>>;
        try {
          ctx = await verifySelfHostedToken(token, documentName, options.tokenSecret);
        } catch (error) {
          // No signing key configured. A server misconfiguration, not a bad
          // client — reported as such, and still fatal to the handshake.
          reportCollaborationError({
            scope: 'authorize',
            operation: 'onAuthenticate',
            docName: documentName,
            error,
          });
          throw error;
        }
        if (!ctx) throw new Error('invalid token');

        // "You may not" and "we could not tell" are different answers, and a
        // client that cannot distinguish them retries the first one forever.
        let permission: CollabPermission;
        try {
          permission = await options.authorize(ctx, documentName);
        } catch (error) {
          reportCollaborationError({
            scope: 'authorize',
            operation: 'onAuthenticate',
            docName: documentName,
            error,
          });
          throw new CollabAuthorizationError(documentName, error);
        }

        if (!permission.canRead) {
          throw new CollabForbiddenError(documentName);
        }
        // canWrite has to bind the connection itself: a client that is only
        // told it may not write can simply not ask. Hocuspocus drops inbound
        // updates on a read-only connection while still syncing outbound.
        connectionConfig.readOnly = !permission.canWrite;

        return { collab: ctx };
      },

      /**
       * Presence, from the identity the handshake already proved.
       *
       * It used to live in `onConnect` and re-parse `?token=` off the query
       * string — a second, unauthenticated decode, so the roster would show
       * whoever the client claimed to be even once `onAuthenticate` started
       * checking signatures. `connected` runs after authentication and gets
       * the verified context, and it is the hook that pairs with
       * `onDisconnect`: a connection that reaches one reaches the other.
       */
      async connected({ documentName, socketId, context }: connectedPayload) {
        const ctx = (context as { collab?: CollabConnectionContext } | undefined)?.collab;
        if (options.presence && ctx?.userId) {
          presenceBySocket.set(socketId, { documentName, userId: ctx.userId });
          await options.presence.join(documentName, {
            userId: ctx.userId,
            ...(ctx.user ? { name: ctx.user.name } : {}),
          });
        }
      },

      async onDisconnect({ socketId }: onDisconnectPayload) {
        const entry = presenceBySocket.get(socketId);
        if (!entry) return;
        presenceBySocket.delete(socketId);
        if (!options.presence) return;

        // One user, two tabs: the roster entry only goes away with the last
        // socket that user holds on that document.
        const stillConnected = [...presenceBySocket.values()].some(
          (other) => other.documentName === entry.documentName && other.userId === entry.userId,
        );
        if (stillConnected) return;

        await options.presence.leave(entry.documentName, entry.userId);
      },

      // Seed each in-memory doc from the persisted state: without this hook the
      // Hocuspocus doc starts EMPTY on every connection, so a previously saved
      // document comes back blank to clients (and is then overwritten on save).
      //
      // Nothing persisted means the document is being opened for the first
      // time — the one moment the declaration's `load` gets to say what it
      // should contain. A document that already has state never reaches it.
      //
      // The RETURN TYPE is load-bearing: Hocuspocus 4 applies what this hook
      // resolves to only when it is a `Y.Doc` or a `Uint8Array` (server line
      // 1477), and drops anything else without a word. This used to return
      // `{ document }` — the v1 shape — so the hook ran, read the right bytes
      // and handed them to a branch that ignored them: every socket got the
      // empty document the persistence fix was written to prevent, and only a
      // test that called the hook directly could still see it "working".
      async onLoadDocument({ documentName }: onLoadDocumentPayload) {
        const stored = await storage.loadDocument(documentName);
        if (stored?.state && stored.state.byteLength > 0) return stored.state;

        return seedDocumentOnce(documentName);
      },

      async onStoreDocument({ documentName, document }) {
        // Hocuspocus swallows what this hook throws, so a storage outage was
        // completely silent — indistinguishable from a healthy save.
        try {
          await storage.saveDocument(documentName, Y.encodeStateAsUpdate(document));
        } catch (error) {
          reportCollaborationError({
            scope: 'storage',
            operation: 'saveDocument',
            docName: documentName,
            error,
          });
          throw error;
        }
      },

      // CRITICAL: when the last client disconnects (F5 / close tab / nav away),
      // Hocuspocus's default onClose path (server line 1382) only flushes the
      // debouncer IF there's a pending save — otherwise it calls unloadDocument
      // and silently destroys the Y.Doc. Result: edits made between the last
      // onStoreDocument and the disconnect are lost. We hook beforeUnloadDocument
      // to persist synchronously before the doc is destroyed, regardless of
      // debouncer state. This makes F5 reliable.
      async beforeUnloadDocument({ documentName, document }) {
        try {
          await storage.saveDocument(documentName, Y.encodeStateAsUpdate(document));
        } catch (error) {
          reportCollaborationError({
            scope: 'storage',
            operation: 'saveDocument',
            docName: documentName,
            error,
          });
          throw error;
        }
      },

      debounce: options.debounce ?? 2000,
    });
  }

  /**
   * The live document, or `undefined` when this process has none open.
   *
   * Public because the alternative was worse: apps that have to merge an
   * external change into what people are currently typing were reaching
   * `hocuspocus.documents` through a cast on a private field, and a private
   * name that a consumer depends on is a public name with none of the
   * guarantees. Reach it through `manager.withLiveDocument` rather than the
   * driver — see {@link LiveDocumentDriver}.
   */
  liveDocument(name: string): Y.Doc | undefined {
    // The Hocuspocus document extends Y.Doc directly.
    return this.hocuspocus.documents.get(name);
  }

  private hydrate(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    if (state.byteLength > 0) {
      Y.applyUpdate(doc, state);
    }
    return doc;
  }

  private async ensureDoc(name: string): Promise<Y.Doc> {
    const existing = this.liveDocument(name);
    if (existing) return existing;

    const stored = await this.storage.loadDocument(name);
    return this.hydrate(stored?.state ?? new Uint8Array());
  }

  async attach(server: import('node:http').Server): Promise<void> {
    const path = this.options.path ?? '/collaboration';
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const parsed = new URL(request.url ?? '/', 'http://localhost');
      if (parsed.pathname !== path) return;

      wss.handleUpgrade(request, socket as import('node:net').Socket, head, (ws) => {
        // Hocuspocus expects a Fetch API Request; we convert the node
        // IncomingMessage into a minimal Request with the real URL.
        const fetchRequest = new Request(parsed, {
          headers: request.headers as unknown as Record<string, string>,
        });

        // Hocuspocus 4 does not listen on the socket. `handleConnection` takes a
        // `WebSocketLike` (send/close/readyState — no events) and hands back a
        // `ClientConnection` that the integrator feeds, exactly as the package's
        // own `Server` does through crossws. Calling `handleConnection` and
        // dropping the return value looked like a working server: the socket
        // opened, the client sent Auth + SyncStep1, and nothing ever answered —
        // no document loaded, nothing stored, every version a 2-byte snapshot.
        const connection = this.hocuspocus.handleConnection(ws, fetchRequest);

        ws.on('message', (data) => {
          connection.handleMessage(toUint8Array(data));
        });
        ws.on('close', (code, reason) => {
          connection.handleClose({ code, reason: reason.toString() });
        });
        ws.on('error', (error) => {
          reportCollaborationError({ scope: 'transport', operation: 'websocket', error });
        });
      });
    });
  }

  async getDocumentState(docName: string): Promise<Uint8Array> {
    const live = this.liveDocument(docName);
    if (live) {
      return Y.encodeStateAsUpdate(live);
    }
    const stored = await this.storage.loadDocument(docName);
    return stored?.state ?? new Uint8Array();
  }

  async getDocumentText(docName: string): Promise<string> {
    const doc = await this.ensureDoc(docName);

    try {
      const json = TiptapTransformer.fromYdoc(doc) as unknown as Record<string, unknown>;
      const defaultDoc = (json as { default?: Record<string, unknown> }).default ?? json;
      return tiptapJsonToText(defaultDoc);
    } catch {
      // Empty doc or not in the Tiptap layout.
      return '';
    }
  }

  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    const doc = await this.ensureDoc(docName);
    const existing = await this.storage.listVersions(docName);
    const version = createVersionMetadata(createdBy, label, seqVersions(existing));

    await this.storage.saveVersion(docName, version, Y.encodeStateAsUpdate(doc));
    return version;
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return this.storage.listVersions(docName);
  }

  /**
   * Restores `versionId` into the live document — and keeps what it replaced.
   *
   * The state being overwritten is written to the history first, as a new
   * version attributed to `restoredBy` and labelled `restored from #<seq>`.
   * Without that step a restore is a destructive edit with no undo, which is
   * the opposite of what a version history is for.
   */
  async restoreVersion(
    docName: string,
    versionId: string,
    restoredBy: string | null,
  ): Promise<void> {
    // Resolve the target first: a missing version must fail before anything
    // is written, so a bad id never lands a spurious version in the history.
    const state = await this.getVersionState(docName, versionId);
    const restoredDoc = this.hydrate(state);

    const live = await this.ensureDoc(docName);
    const existing = await this.storage.listVersions(docName);
    const target = existing.find((version) => version.id === versionId);

    await this.storage.saveVersion(
      docName,
      createVersionMetadata(
        restoredBy,
        restoredFromLabel(target, versionId),
        seqVersions(existing),
      ),
      Y.encodeStateAsUpdate(live),
    );

    // Applies the restored content to the live doc — connected clients receive
    // the change in real time via the Hocuspocus sync protocol.
    live.transact(() => {
      applyRestoredContent(live, restoredDoc);
    });

    await this.storage.saveDocument(docName, Y.encodeStateAsUpdate(live));
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aState, bState] = await Promise.all([
      this.getVersionState(docName, aId),
      this.getVersionState(docName, bId),
    ]);

    const textA = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(aState)));
    const textB = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(bState)));

    return lineDiff(textA, textB);
  }

  /** Binary state stored for a version. Throws when the id is unknown. */
  async getVersionState(docName: string, versionId: string): Promise<Uint8Array> {
    const persisted = await this.storage.loadVersionSnapshot(docName, versionId);
    if (!persisted) throw new Error(`Version ${versionId} not found`);
    return persisted;
  }

  async close(): Promise<void> {
    // Persists pending docs and closes connections (the Hocuspocus class has
    // no destroy — the embedded Server does).
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    if (!this.wss) return;
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}

/* ───────────────────────── local helpers ───────────────────────── */

/**
 * Normalises what a declaration's `load` returned into a Yjs update.
 *
 * A `Uint8Array` is already one. Everything else is taken as the `Y.Doc` the
 * type allows and encoded — deliberately without an `instanceof Y.Doc` check
 * on the way, because an app that ends up with a second copy of `yjs` in its
 * tree (a transformer pinned to another minor) produces documents that fail
 * `instanceof` while encoding perfectly well, and a failed check here would
 * silently seed nothing at all.
 *
 * A zero-byte update is treated as no seed: applying it is a no-op, and
 * persisting it would tell every later connection that this document has
 * already been seeded. An *empty document* is not the same thing — it encodes
 * to a real (2-byte) update and does count as seeded, which is why `load`
 * returns `null` for "there is nothing", not an empty doc.
 */
function seedUpdate(seed: CollabDocumentSeed): Uint8Array | undefined {
  if (!seed) return undefined;
  const update = seed instanceof Uint8Array ? seed : Y.encodeStateAsUpdate(seed);
  return update.byteLength > 0 ? update : undefined;
}

function safeTiptapFromYdoc(doc: Y.Doc): Record<string, unknown> {
  try {
    return TiptapTransformer.fromYdoc(doc) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Per-line diff, simple enough for the summary (+added / -removed). */
function simpleLineDiff(a: string, b: string): CollabDiffSummary {
  const linesA = new Set(a.split('\n'));
  const linesB = new Set(b.split('\n'));

  let added = 0;
  for (const line of linesB) {
    if (!linesA.has(line)) added++;
  }
  let removed = 0;
  for (const line of linesA) {
    if (!linesB.has(line)) removed++;
  }
  return { added, removed };
}

/**
 * Replaces the live doc's content by applying the restored doc's full update
 * (CRDT merge is idempotent; the preceding delete removes the divergent state
 * and the update brings the old content back).
 */
function applyRestoredContent(live: Y.Doc, restored: Y.Doc): void {
  const liveFragment = live.getXmlFragment('default');
  liveFragment.delete(0, liveFragment.length);

  const update = Y.encodeStateAsUpdate(restored);
  Y.applyUpdate(live, update);
}
