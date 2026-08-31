import * as A from '@automerge/automerge';
import { next as ANext } from '@automerge/automerge';
import { WebSocketServer } from 'ws';
import { parseLegacyToken } from '../../auth/token.js';
import type { CollaborationDriver, SelfHostedDriverOptions } from '../../driver.js';
import { reportCollaborationError } from '../../observability.js';
import type {
  CollabDiffSummary,
  CollaborationStorage,
  CollabPermission,
  CollabVersion,
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
 * Transport: clients speak Automerge's binary protocol
 * (@automerge/automerge-repo-network-websocket on the client). On the server
 * we use an in-memory DocHandle + simple per-room broadcast; for horizontal
 * scaling, updates are re-broadcast via Redis pub/sub (same philosophy as transmit).
 */

/** Connections whose permission denied canWrite — their updates are dropped. */
const readOnlyClients = new WeakSet<object>();

/** userId behind each open socket — feeds the presence roster on close. */
const socketUsers = new WeakMap<object, string>();

interface Room {
  // biome-ignore lint/suspicious/noExplicitAny: automerge's typing is unstable between minors
  text: any;
  clients: Set<import('ws').WebSocket>;
}

export class AutomergeDriver implements CollaborationDriver {
  readonly engine = 'automerge';

  private rooms = new Map<string, Room>();
  private wss?: WebSocketServer;
  private readonly options: SelfHostedDriverOptions;
  private readonly storage: CollaborationStorage;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: SelfHostedDriverOptions) {
    this.options = options;
    this.storage = resolveStorage(options.storage);
  }

  private async loadRoom(docName: string): Promise<Room> {
    let room = this.rooms.get(docName);
    if (room) return room;

    const stored = await this.storage.loadDocument(docName);
    const doc = stored
      ? A.load<Record<string, unknown>>(stored.state)
      : A.from({ content: '' } as Record<string, unknown>);

    room = { text: doc, clients: new Set() };
    this.rooms.set(docName, room);
    return room;
  }

  private broadcast(room: Room, payload: Uint8Array, sender?: import('ws').WebSocket): void {
    for (const client of room.clients) {
      if (client !== sender && client.readyState === 1) {
        client.send(payload);
      }
    }
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

        // Authentication: base64 token in the query (?token=...&doc=...).
        const token = url.searchParams.get('token');
        if (!token) {
          ws.close(4001, 'not authenticated');
          return;
        }

        const ctx = parseLegacyToken(token);
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

          await this.options.presence?.join(docName, {
            userId: ctx.userId,
            ...(ctx.user?.name ? { name: ctx.user.name } : {}),
          });

          // Sends the full state to the new client.
          ws.send(A.save(room.text));

          ws.on('message', (data) => {
            // A read-only connection still receives every update; its own are
            // dropped. Enforced here because the client cannot be trusted to
            // respect a permission it was merely told about.
            if (readOnlyClients.has(ws)) return;
            void this.handleClientMessage(docName, data as Uint8Array, ws);
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
          });
          socketUsers.set(ws, ctx.userId);
        } catch (error) {
          reportCollaborationError({ scope: 'storage', operation: 'loadDocument', docName, error });
          ws.close(4500, 'could not open the document');
        }
      });
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: automerge's typing is unstable between minors
  private async handleClientMessage(docName: string, data: Uint8Array, sender: any): Promise<void> {
    const room = await this.loadRoom(docName);

    try {
      // Client sends an incremental binary doc; merge into the server doc.
      const incoming = A.load<Record<string, unknown>>(data);
      const merged = A.merge(room.text, incoming);
      room.text = merged;

      this.broadcast(room, data, sender);

      // Persistence with simple per-room debounce.
      await this.persistDebounced(docName, room);
    } catch {
      // Invalid payload: ignore (a badly-behaved client doesn't take down the room).
    }
  }

  private persistDebounced(docName: string, room: Room): Promise<void> {
    return new Promise((resolve) => {
      const existing = this.persistTimers.get(docName);
      if (existing) clearTimeout(existing);

      this.persistTimers.set(
        docName,
        setTimeout(() => {
          void this.storage
            .saveDocument(docName, A.save(room.text))
            .catch((error: unknown) => {
              reportCollaborationError({
                scope: 'storage',
                operation: 'saveDocument',
                docName,
                error,
              });
            })
            .finally(() => resolve());
        }, this.options.debounce ?? 2000),
      );
    });
  }

  async getDocumentState(docName: string): Promise<Uint8Array> {
    const room = await this.loadRoom(docName);
    return A.save(room.text);
  }

  async getDocumentText(docName: string): Promise<string> {
    const room = await this.loadRoom(docName);
    const content = (room.text as unknown as { content?: { toString(): string } }).content;
    return content ? content.toString() : '';
  }

  /** Versions = markers over the native history (heads hash). */
  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    const room = await this.loadRoom(docName);
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
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return this.storage.listVersions(docName);
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
    const bytes = await this.storage.loadVersionSnapshot(docName, versionId);
    if (!bytes) throw new Error(`Version ${versionId} not found`);

    const snapshotDoc = A.load<Record<string, unknown>>(bytes);
    const room = await this.loadRoom(docName);

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

    const merged = A.merge(room.text, snapshotDoc);
    // Automerge merge converges to the most recent state; to "restore",
    // we overwrite the content field with the value from the version.
    const restoredContent = (snapshotDoc as unknown as { content?: { toString(): string } })
      .content;
    const finalDoc = A.change(merged, (doc) => {
      (doc as { content: string }).content = restoredContent?.toString() ?? '';
    });

    room.text = finalDoc;
    this.broadcast(room, A.save(finalDoc));
    await this.storage.saveDocument(docName, A.save(finalDoc));
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aBytes, bBytes] = await Promise.all([
      this.storage.loadVersionSnapshot(docName, aId),
      this.storage.loadVersionSnapshot(docName, bId),
    ]);
    if (!aBytes || !bBytes) throw new Error('Version not found');

    const textOf = (bytes: Uint8Array) => {
      const doc = A.load<{ content?: { toString(): string } }>(bytes);
      return doc.content?.toString() ?? '';
    };

    return lineDiff(textOf(aBytes), textOf(bBytes));
  }

  async close(): Promise<void> {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    // `this.wss?.close(cb)` never runs cb when there is no server, so this
    // promise used to hang forever on a driver that was never attached —
    // which is every driver outside the web process.
    if (!this.wss) return;
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}
