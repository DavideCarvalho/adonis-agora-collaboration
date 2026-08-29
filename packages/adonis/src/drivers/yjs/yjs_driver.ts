import {
  Hocuspocus,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
} from '@hocuspocus/server';
import type { onConnectPayload, onDisconnectPayload } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import {
  CollabAuthorizationError,
  CollabForbiddenError,
  parseLegacyToken,
} from '../../auth/token.js';
import type { CollaborationDriver, SelfHostedDriverOptions } from '../../driver.js';
import { reportCollaborationError } from '../../observability.js';
import type {
  CollabDiffSummary,
  CollabPermission,
  CollabVersion,
  CollaborationStorage,
} from '../../types.js';
import { createVersionMetadata, restoredFromLabel, seqVersions } from '../../versioning.js';
import { lineDiff, resolveStorage, tiptapJsonToText } from '../shared.js';

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

export class YjsDriver implements CollaborationDriver {
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

    this.hocuspocus = new Hocuspocus({
      async onAuthenticate({ documentName, token, connectionConfig }: onAuthenticatePayload) {
        const ctx = parseLegacyToken(token);
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
      },

      async onConnect({ documentName, requestParameters, socketId }: onConnectPayload) {
        const token = requestParameters.get('token');
        const ctx = token ? parseLegacyToken(token) : null;
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
      async onLoadDocument({ documentName }: onLoadDocumentPayload) {
        const stored = await storage.loadDocument(documentName);
        if (stored?.state && stored.state.byteLength > 0) {
          const doc = new Y.Doc();
          Y.applyUpdate(doc, stored.state);
          return { document: doc };
        }
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

  private liveDoc(name: string): Y.Doc | undefined {
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
    const existing = this.liveDoc(name);
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
        this.hocuspocus.handleConnection(ws, fetchRequest);
      });
    });
  }

  async getDocumentState(docName: string): Promise<Uint8Array> {
    const live = this.liveDoc(docName);
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
    const state = await this.versionState(docName, versionId);
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
      this.versionState(docName, aId),
      this.versionState(docName, bId),
    ]);

    const textA = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(aState)));
    const textB = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(bState)));

    return lineDiff(textA, textB);
  }

  private async versionState(docName: string, versionId: string): Promise<Uint8Array> {
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
