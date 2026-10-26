import * as A from '@automerge/automerge';
import { next as ANext } from '@automerge/automerge';
import { WebSocketServer } from 'ws';
import { verifySelfHostedToken } from '../../auth/token.js';
import type { CollaborationDriver, SelfHostedDriverOptions } from '../../driver.js';
import { reportCollaborationError, reportCollaborationWarning } from '../../observability.js';
import type {
  CollabDiffSummary,
  CollaborationStorage,
  CollabPermission,
  CollabVersion,
  ListPageOptions,
} from '../../types.js';
import { createVersionMetadata, restoredFromLabel, seqVersions } from '../../versioning.js';
import { lineDiff, resolveStorage } from '../shared.js';

/**
 * Automerge driver.
 *
 * Automerge has NATIVE version control: every change generates a hash and
 * the full history lives inside the doc itself (`Automerge.getHistory`).
 * `createVersion` here is just a marker (label + hash heads) — the content
 * between versions is already in the doc. `restoreVersion` brings the doc
 * back to the version's heads via a compensating change (non-destructive).
 *
 * Transport: one in-memory doc per room and a per-room broadcast. Every
 * client gets the whole `A.save(doc)` on connect. After that, a socket opened
 * with `?sync=changes` is answered with the {@link CHANGES_ACK} text frame and
 * from then on exchanges change chunks (`A.saveSince`) both ways; any other
 * socket sends and receives whole saved documents. The server applies both
 * shapes with `A.loadIncremental`, so one room can hold both kinds of client.
 *
 * A room lives while it has clients: when the last one leaves, its pending
 * save is written and the room is dropped from memory.
 */

/** Query parameter (and value) a client sets to ask for change chunks. */
const CHANGES_PARAM = 'sync';
const CHANGES_PARAM_VALUE = 'changes';
/** Text frame confirming that this socket exchanges change chunks. */
export const CHANGES_ACK = 'automerge-sync:changes';

/** Longest a burst of edits can keep postponing its save. */
const MAX_PERSIST_WAIT_MS = 10_000;

/** Connections whose permission denied canWrite — their updates are dropped. */
const readOnlyClients = new WeakSet<object>();

/** userId behind each open socket — feeds the presence roster on close. */
const socketUsers = new WeakMap<object, string>();

/** Sockets that exchange change chunks instead of whole documents. */
const changeClients = new WeakSet<object>();

interface Room {
  // biome-ignore lint/suspicious/noExplicitAny: automerge's typing is unstable between minors
  text: any;
  clients: Set<import('ws').WebSocket>;
  /** Driver calls (REST reads, versions) currently using the room. */
  holds: number;
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  /** When the save runs even if edits keep arriving. */
  deadline: number;
  room: Room;
}

function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((hash, index) => hash === b[index]);
}

export class AutomergeDriver implements CollaborationDriver {
  readonly engine = 'automerge';

  private rooms = new Map<string, Room>();
  private wss?: WebSocketServer;
  private readonly options: SelfHostedDriverOptions;
  private readonly storage: CollaborationStorage;
  private pendingSaves = new Map<string, PendingSave>();
  /** Saves being written, by document name; a room is not dropped under one. */
  private savesInFlight = new Map<string, Promise<void>>();
  /**
   * Rooms being opened, by document name.
   *
   * `loadRoom` reads the storage before it registers the room, so two
   * messages arriving on a cold document used to open it twice and the second
   * `rooms.set` threw the first room — and its clients' merges — away. With a
   * seeding `load` in the picture that stops being a lost update and becomes
   * duplicated content, so the window has to close.
   */
  private roomLoads = new Map<string, Promise<Room>>();

  constructor(options: SelfHostedDriverOptions) {
    this.options = options;
    this.storage = resolveStorage(options.storage);
  }

  private loadRoom(docName: string): Promise<Room> {
    const room = this.rooms.get(docName);
    if (room) return Promise.resolve(room);

    const loading = this.roomLoads.get(docName);
    if (loading) return loading;

    const opening = this.openRoom(docName);
    this.roomLoads.set(docName, opening);
    return opening.finally(() => this.roomLoads.delete(docName));
  }

  private async openRoom(docName: string): Promise<Room> {
    const stored = await this.storage.loadDocument(docName);
    const doc = stored
      ? A.load<Record<string, unknown>>(stored.state)
      : await this.seedDocument(docName);

    const room: Room = { text: doc, clients: new Set<import('ws').WebSocket>(), holds: 0 };
    this.rooms.set(docName, room);
    return room;
  }

  /**
   * The document a name is born with: the declaration's `load`, else the
   * empty `{ content: '' }` this driver has always started from.
   *
   * Automerge gets the hook for the same reason Yjs does — the room is the
   * only copy the clients will ever see, so content that is not in it when
   * the first client connects is content the first save will erase. What it
   * does NOT get is the `Y.Doc` shortcut: seeds arrive here as `A.save(doc)`
   * bytes, and anything else is a configuration mistake worth naming rather
   * than a document worth guessing at.
   */
  // biome-ignore lint/suspicious/noExplicitAny: automerge's typing is unstable between minors
  private async seedDocument(docName: string): Promise<any> {
    const empty = () => A.from({ content: '' } as Record<string, unknown>);
    if (!this.options.seedDocument) return empty();

    let seed: Awaited<ReturnType<NonNullable<SelfHostedDriverOptions['seedDocument']>>>;
    try {
      seed = await this.options.seedDocument(docName);
    } catch (error) {
      // A failing seed opens the document empty; it must never close the
      // connection, which the client would only retry.
      reportCollaborationError({ scope: 'storage', operation: 'loadDocument', docName, error });
      return empty();
    }

    if (!seed) return empty();
    if (!(seed instanceof Uint8Array)) {
      reportCollaborationWarning(
        { docName },
        `document "${docName}" runs on the automerge engine, but its load() returned a Y.Doc — ` +
          'an Automerge seed is the bytes of A.save(doc). Opening the document empty.',
      );
      return empty();
    }

    let doc: unknown;
    try {
      doc = A.load<Record<string, unknown>>(seed);
    } catch (error) {
      reportCollaborationError({ scope: 'storage', operation: 'loadDocument', docName, error });
      return empty();
    }

    // Persisted before it is served: without this the hook would run again on
    // every cold room, and the app would pay the read every time.
    try {
      await this.storage.saveDocument(docName, seed);
    } catch (error) {
      reportCollaborationError({ scope: 'storage', operation: 'saveDocument', docName, error });
    }
    return doc;
  }

  /**
   * Sends everything the room gained since `since` to every client but the
   * sender: the change chunk to sockets that speak chunks, a whole document
   * (`wholeDoc`, else `A.save` of the room) to the rest. Each shape is
   * encoded at most once per call.
   */
  private broadcast(
    room: Room,
    since: string[],
    sender?: import('ws').WebSocket,
    wholeDoc?: Uint8Array,
  ): void {
    let changes: Uint8Array | undefined;
    let whole = wholeDoc;
    for (const client of room.clients) {
      if (client === sender || client.readyState !== 1) continue;
      if (changeClients.has(client)) {
        changes ??= ANext.saveSince(room.text, since);
        client.send(changes);
      } else {
        whole ??= A.save(room.text);
        client.send(whole);
      }
    }
  }

  /** Runs `fn` on the room, dropping it afterwards if nobody else uses it. */
  private async withRoom<T>(docName: string, fn: (room: Room) => Promise<T> | T): Promise<T> {
    const room = await this.loadRoom(docName);
    room.holds += 1;
    try {
      return await fn(room);
    } finally {
      room.holds -= 1;
      void this.releaseRoom(docName, room);
    }
  }

  /**
   * Writes the room's pending save and drops it from memory once nothing
   * uses it: no client, no driver call, no save waiting or being written.
   * A client that joins meanwhile finds the same room in the map.
   */
  private async releaseRoom(docName: string, room: Room): Promise<void> {
    const idle = () => room.clients.size === 0 && room.holds === 0;
    while (idle() && (this.pendingSaves.has(docName) || this.savesInFlight.has(docName))) {
      await this.persistNow(docName);
    }
    if (idle() && this.rooms.get(docName) === room) this.rooms.delete(docName);
  }

  async attach(server: import('node:http').Server): Promise<void> {
    const path = this.options.path ?? '/collaboration';
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== path) return;

      wss.handleUpgrade(request, socket as import('node:net').Socket, head, async (ws) => {
        const docName = decodeURIComponent(url.searchParams.get('doc') ?? '');
        if (!docName) {
          ws.close(4000, 'doc required');
          return;
        }

        // Authentication: signed token in the query (?token=...&doc=...).
        //
        // Verified, not decoded. This used to accept the base64 of any JSON
        // with a `userId` in it, which made the query string an identity
        // claim anyone could write: no session, no cookie, no login — just
        // `?token=base64({"userId":"<victim>"})` and the room opened as them.
        // `docName` is the document this socket asked for, so the check also
        // pins the token to it.
        const token = url.searchParams.get('token');
        if (!token) {
          ws.close(4001, 'not authenticated');
          return;
        }

        let ctx: Awaited<ReturnType<typeof verifySelfHostedToken>>;
        try {
          ctx = await verifySelfHostedToken(token, docName, this.options.tokenSecret);
        } catch (error) {
          // No signing key: a server misconfiguration, and a distinct answer
          // from a rejected token so the logs say which one happened.
          reportCollaborationError({ scope: 'authorize', operation: 'upgrade', docName, error });
          ws.close(4503, 'authentication unavailable');
          return;
        }
        if (!ctx) {
          ws.close(4001, 'authentication failed');
          return;
        }

        // A denial and an outage are different events for the client: 4003
        // is final, 4503 is worth retrying. Reporting one as the other is
        // how an app-side database error becomes a reconnect storm.
        let permission: CollabPermission;
        try {
          permission = await this.options.authorize(ctx, docName);
        } catch (error) {
          reportCollaborationError({
            scope: 'authorize',
            operation: 'upgrade',
            docName,
            error,
          });
          ws.close(4503, 'authorization unavailable');
          return;
        }

        if (!permission.canRead) {
          ws.close(4003, 'no access');
          return;
        }

        try {
          const room = await this.loadRoom(docName);
          room.clients.add(ws);
          if (!permission.canWrite) readOnlyClients.add(ws);
          const sendsChanges = url.searchParams.get(CHANGES_PARAM) === CHANGES_PARAM_VALUE;
          if (sendsChanges) changeClients.add(ws);

          await this.options.presence?.join(docName, {
            userId: ctx.userId,
            ...(ctx.user?.name ? { name: ctx.user.name } : {}),
          });

          // The acknowledgement goes before the state, so the client knows
          // the shape of its first send before it makes it.
          if (sendsChanges) ws.send(CHANGES_ACK);
          ws.send(A.save(room.text));

          ws.on('message', (data) => {
            // A read-only connection still receives every update; its own are
            // dropped. Enforced here because the client cannot be trusted to
            // respect a permission it was merely told about.
            if (readOnlyClients.has(ws)) return;
            this.handleClientMessage(docName, room, data as Uint8Array, ws);
          });

          ws.on('close', () => {
            room.clients.delete(ws);
            readOnlyClients.delete(ws);
            // Only the user's LAST socket on this document leaves the roster.
            const stillConnected = [...room.clients].some(
              (client) => socketUsers.get(client) === ctx.userId,
            );
            socketUsers.delete(ws);
            if (!stillConnected) {
              void this.options.presence?.leave(docName, ctx.userId);
            }
            void this.releaseRoom(docName, room);
          });
          socketUsers.set(ws, ctx.userId);
        } catch (error) {
          reportCollaborationError({ scope: 'storage', operation: 'loadDocument', docName, error });
          ws.close(4500, 'could not open the document');
        }
      });
    });
  }

  /**
   * Applies a client's whole document or change chunk and forwards only what
   * was new to the room. A payload that adds nothing — a duplicate, or bytes
   * that are not Automerge at all — is neither forwarded nor saved.
   */
  private handleClientMessage(
    docName: string,
    room: Room,
    data: Uint8Array,
    sender: import('ws').WebSocket,
  ): void {
    try {
      const before = ANext.getHeads(room.text);
      room.text = A.loadIncremental(room.text, data);
      if (sameHeads(before, ANext.getHeads(room.text))) return;

      // A whole document from a whole-document client is forwarded as it came
      // to the other whole-document clients: it is already the payload they need.
      this.broadcast(room, before, sender, changeClients.has(sender) ? undefined : data);
      this.schedulePersist(docName, room);
    } catch {
      // Invalid payload: ignore (a badly-behaved client doesn't take down the room).
    }
  }

  /**
   * Debounced save: each edit postpones it by `debounce`, but never past
   * {@link MAX_PERSIST_WAIT_MS} (or `debounce`, if longer) after the first
   * unsaved edit, so a document edited without pause is still written.
   */
  private schedulePersist(docName: string, room: Room): void {
    const debounce = this.options.debounce ?? 2000;
    const now = Date.now();
    const pending = this.pendingSaves.get(docName);
    if (pending) clearTimeout(pending.timer);
    const deadline = pending?.deadline ?? now + Math.max(MAX_PERSIST_WAIT_MS, debounce);

    const timer = setTimeout(
      () => void this.persistNow(docName),
      Math.max(0, Math.min(debounce, deadline - now)),
    );
    this.pendingSaves.set(docName, { timer, deadline, room });
  }

  /** Writes the pending save of `docName` now, if there is one. */
  private async persistNow(docName: string): Promise<void> {
    const pending = this.pendingSaves.get(docName);
    if (!pending) return this.savesInFlight.get(docName);
    clearTimeout(pending.timer);
    this.pendingSaves.delete(docName);
    await this.save(docName, A.save(pending.room.text));
  }

  /** Saves `state`, tracked so the room is not dropped while it is written. */
  private async save(docName: string, state: Uint8Array): Promise<void> {
    const previous = this.savesInFlight.get(docName);
    const write = (async () => {
      // Writes of one document stay in order, so an older state never lands last.
      await previous;
      try {
        await this.storage.saveDocument(docName, state);
      } catch (error) {
        reportCollaborationError({ scope: 'storage', operation: 'saveDocument', docName, error });
      }
    })();
    this.savesInFlight.set(docName, write);
    try {
      await write;
    } finally {
      if (this.savesInFlight.get(docName) === write) this.savesInFlight.delete(docName);
    }
  }

  async getDocumentState(docName: string): Promise<Uint8Array> {
    return this.withRoom(docName, (room) => A.save(room.text));
  }

  async getDocumentText(docName: string): Promise<string> {
    return this.withRoom(docName, (room) => {
      const content = (room.text as unknown as { content?: { toString(): string } }).content;
      return content ? content.toString() : '';
    });
  }

  /** Versions = markers over the native history (heads hash). */
  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    return this.withRoom(docName, async (room) => {
      const heads = ANext.getHeads(room.text);
      const existing = await this.storage.listVersions(docName);

      const version: CollabVersion = {
        ...createVersionMetadata(createdBy, label, seqVersions(existing)),
        id: heads.join(','),
      };

      // Snapshot = binary save of the doc up to those heads (Automerge compresses
      // well; storing the whole doc as the "snapshot" keeps restore O(1)).
      await this.storage.saveVersion(docName, version, A.save(room.text));
      return version;
    });
  }

  async listVersions(docName: string, page?: ListPageOptions): Promise<CollabVersion[]> {
    return this.storage.listVersions(docName, page);
  }

  /**
   * Restores `versionId` — recording the state it replaces as a new version
   * attributed to `restoredBy`, per the driver contract. Automerge keeps the
   * change history natively, but the *version list* is ours, and a restore
   * that leaves no entry in it is a restore nobody can undo.
   */
  async restoreVersion(
    docName: string,
    versionId: string,
    restoredBy: string | null,
  ): Promise<void> {
    const bytes = await this.getVersionState(docName, versionId);
    const snapshotDoc = A.load<Record<string, unknown>>(bytes);
    await this.withRoom(docName, (room) =>
      this.restoreRoom(docName, room, versionId, snapshotDoc, restoredBy),
    );
  }

  private async restoreRoom(
    docName: string,
    room: Room,
    versionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: automerge's typing is unstable between minors
    snapshotDoc: any,
    restoredBy: string | null,
  ): Promise<void> {
    const existing = await this.storage.listVersions(docName);
    const target = existing.find((version) => version.id === versionId);
    await this.storage.saveVersion(
      docName,
      {
        ...createVersionMetadata(
          restoredBy,
          restoredFromLabel(target, versionId),
          seqVersions(existing),
        ),
        id: ANext.getHeads(room.text).join(','),
      },
      A.save(room.text),
    );

    const before = ANext.getHeads(room.text);
    const merged = A.merge(room.text, snapshotDoc);
    // Automerge merge converges to the most recent state; to "restore",
    // we overwrite the content field with the value from the version.
    const restoredContent = (snapshotDoc as unknown as { content?: { toString(): string } })
      .content;
    const finalDoc = A.change(merged, (doc) => {
      (doc as { content: string }).content = restoredContent?.toString() ?? '';
    });

    room.text = finalDoc;
    this.broadcast(room, before);
    // The restore supersedes any debounced save of the state it replaced.
    const pending = this.pendingSaves.get(docName);
    if (pending) clearTimeout(pending.timer);
    this.pendingSaves.delete(docName);
    await this.save(docName, A.save(finalDoc));
  }

  /** Binary state stored for a version (`A.save` of the doc at that point). */
  async getVersionState(docName: string, versionId: string): Promise<Uint8Array> {
    const persisted = await this.storage.loadVersionSnapshot(docName, versionId);
    if (!persisted) throw new Error(`Version ${versionId} not found`);
    return persisted;
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aBytes, bBytes] = await Promise.all([
      this.getVersionState(docName, aId),
      this.getVersionState(docName, bId),
    ]);

    const textOf = (bytes: Uint8Array) => {
      const doc = A.load<{ content?: { toString(): string } }>(bytes);
      return doc.content?.toString() ?? '';
    };

    return lineDiff(textOf(aBytes), textOf(bBytes));
  }

  async close(): Promise<void> {
    // Edits still inside their debounce are written, not dropped.
    await Promise.all([...this.pendingSaves.keys()].map((docName) => this.persistNow(docName)));
    await Promise.all(this.savesInFlight.values());
    // `this.wss?.close(cb)` never runs cb when there is no server, so this
    // promise used to hang forever on a driver that was never attached —
    // which is every driver outside the web process.
    if (!this.wss) return;
    // `wss.close` only calls back once every client is gone.
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}
