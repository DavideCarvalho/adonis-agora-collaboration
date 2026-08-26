import * as A from '@automerge/automerge';
import { next as ANext } from '@automerge/automerge';
import { WebSocketServer } from 'ws';
import { parseLegacyToken } from '../../auth/token.js';
import type { CollaborationDriver, SelfHostedDriverOptions } from '../../driver.js';
import type { CollabDiffSummary, CollabVersion, CollaborationStorage } from '../../types.js';
import { createVersionMetadata, seqVersions } from '../../versioning.js';
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

        try {
          const ctx = JSON.parse(Buffer.from(token, 'base64').toString()) as {
            userId: string;
          };
          const permission = await this.options.authorize(ctx, docName);
          if (!permission.canRead) {
            ws.close(4003, 'no access');
            return;
          }

          const room = await this.loadRoom(docName);
          room.clients.add(ws);

          // Sends the full state to the new client.
          ws.send(A.save(room.text));

          ws.on('message', (data) => {
            void this.handleClientMessage(docName, data as Uint8Array, ws);
          });

          ws.on('close', () => {
            room.clients.delete(ws);
          });
        } catch {
          ws.close(4001, 'authentication failed');
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
          void this.storage.saveDocument(docName, A.save(room.text)).finally(() => resolve());
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

  async restoreVersion(
    docName: string,
    versionId: string,
    _restoredBy: string | null,
  ): Promise<void> {
    const bytes = await this.storage.loadVersionSnapshot(docName, versionId);
    if (!bytes) throw new Error(`Version ${versionId} not found`);

    const snapshotDoc = A.load<Record<string, unknown>>(bytes);
    const room = await this.loadRoom(docName);
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
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}
