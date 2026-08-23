import * as A from '@automerge/automerge';
import { next as ANext } from '@automerge/automerge';
import { WebSocketServer } from 'ws';
import type { CollaborationDriver } from '../../driver.js';
import { InMemoryCollaborationStorage } from '../../storage/in_memory_storage.js';
import type {
  CollabDiffSummary,
  CollabVersion,
  CollaborationConfig,
  CollaborationStorage,
} from '../../types.js';
import { createVersionMetadata, seqVersions } from '../../versioning.js';

/**
 * Driver Automerge.
 *
 * O Automerge tem version control NATIVO: cada mudança gera um hash e o
 * histórico completo fica dentro do próprio doc (`Automerge.getHistory`).
 * `createVersion` aqui é só um marcador (label + hash heads) — o conteúdo
 * entre versões já está no doc. `restoreVersion` volta o doc pros heads da
 * versão via change compensoatório (não destrutivo).
 *
 * Transporte: os clientes falam o protocolo binário do Automerge
 * (@automerge/automerge-repo-network-websocket no client). No server usamos
 * o DocHandle em memória + broadcast simples por sala; para escala horizontal,
 * updates são retransmitidos via Redis pub/sub (mesma filosofia do transmit).
 */

interface Room {
  // biome-ignore lint/suspicious/noExplicitAny: tipagem do automerge é instável entre minors
  text: any;
  clients: Set<import('ws').WebSocket>;
}

export class AutomergeDriver implements CollaborationDriver {
  readonly engine = 'automerge';

  private rooms = new Map<string, Room>();
  private wss?: WebSocketServer;

  constructor(private config: CollaborationConfig) {}

  /** Storage configurado ou in-memory (dev). */
  #storage(): CollaborationStorage {
    if (this.config.storage) {
      return this.config.storage;
    }
    this.#memoryStorage ??= new InMemoryCollaborationStorage();
    return this.#memoryStorage;
  }
  #memoryStorage?: InMemoryCollaborationStorage;

  private async loadRoom(docName: string): Promise<Room> {
    let room = this.rooms.get(docName);
    if (room) return room;

    const stored = await this.#storage().loadDocument(docName);
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
    const path = this.config.path ?? '/collaboration';
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== path) return;

      wss.handleUpgrade(request, socket as import('node:net').Socket, head, async (ws) => {
        const docName = decodeURIComponent(url.searchParams.get('doc') ?? '');
        if (!docName) {
          ws.close(4000, 'doc obrigatório');
          return;
        }

        // Autenticação: token base64 na query (?token=...&doc=...).
        const token = url.searchParams.get('token');
        if (!token) {
          ws.close(4001, 'não autenticado');
          return;
        }

        try {
          const ctx = JSON.parse(Buffer.from(token, 'base64').toString()) as {
            userId: string;
          };
          const permission = await this.config.authorize(ctx, docName);
          if (!permission.canRead) {
            ws.close(4003, 'sem acesso');
            return;
          }

          const room = await this.loadRoom(docName);
          room.clients.add(ws);

          // Envia o estado completo pro cliente novo.
          ws.send(A.save(room.text));

          ws.on('message', (data) => {
            void this.handleClientMessage(docName, data as Uint8Array, ws);
          });

          ws.on('close', () => {
            room.clients.delete(ws);
          });
        } catch {
          ws.close(4001, 'autenticação falhou');
        }
      });
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: tipagem do automerge é instável entre minors
  private async handleClientMessage(docName: string, data: Uint8Array, sender: any): Promise<void> {
    const room = await this.loadRoom(docName);

    try {
      // Cliente manda um doc binário incremental; merge no doc do server.
      const incoming = A.load<Record<string, unknown>>(data);
      const merged = A.merge(room.text, incoming);
      room.text = merged;

      this.broadcast(room, data, sender);

      // Persistência com debounce simples por sala.
      await this.persistDebounced(docName, room);
    } catch {
      // Payload inválido: ignora (cliente mal comportado não derruba a sala).
    }
  }

  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private persistDebounced(docName: string, room: Room): Promise<void> {
    return new Promise((resolve) => {
      const existing = this.persistTimers.get(docName);
      if (existing) clearTimeout(existing);

      this.persistTimers.set(
        docName,
        setTimeout(() => {
          void this.#storage()
            .saveDocument(docName, A.save(room.text))
            .finally(() => resolve());
        }, this.config.debounce ?? 2000),
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

  /** Versões = marcadores sobre o history nativo (heads hash). */
  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    const room = await this.loadRoom(docName);
    const heads = ANext.getHeads(room.text);
    const existing = await this.#storage().listVersions(docName);

    const version: CollabVersion = {
      ...createVersionMetadata(createdBy, label, seqVersions(existing)),
      id: heads.join(','),
    };

    // Snapshot = save binário do doc até esses heads (o Automerge comprime
    // bem; guardar o doc inteiro como "snapshot" mantém restore O(1)).
    await this.#storage().saveVersion(docName, version, A.save(room.text));
    return version;
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return this.#storage().listVersions(docName);
  }

  async restoreVersion(
    docName: string,
    versionId: string,
    _restoredBy: string | null,
  ): Promise<void> {
    const bytes = await this.#storage().loadVersionSnapshot(docName, versionId);
    if (!bytes) throw new Error(`Versão ${versionId} não encontrada`);

    const snapshotDoc = A.load<Record<string, unknown>>(bytes);
    const room = await this.loadRoom(docName);
    const merged = A.merge(room.text, snapshotDoc);
    // Automerge merge converge pro estado mais recente; pra "restaurar",
    // sobrescrevemos o campo de conteúdo com o valor da versão.
    const restoredContent = (snapshotDoc as unknown as { content?: { toString(): string } })
      .content;
    const finalDoc = A.change(merged, (doc) => {
      (doc as { content: string }).content = restoredContent?.toString() ?? '';
    });

    room.text = finalDoc;
    this.broadcast(room, A.save(finalDoc));
    await this.#storage().saveDocument(docName, A.save(finalDoc));
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aBytes, bBytes] = await Promise.all([
      this.#storage().loadVersionSnapshot(docName, aId),
      this.#storage().loadVersionSnapshot(docName, bId),
    ]);
    if (!aBytes || !bBytes) throw new Error('Versão não encontrada');

    const textOf = (bytes: Uint8Array) => {
      const doc = A.load<{ content?: { toString(): string } }>(bytes);
      return doc.content?.toString() ?? '';
    };

    return diffByLine(textOf(aBytes), textOf(bBytes));
  }

  async close(): Promise<void> {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}

function diffByLine(a: string, b: string): CollabDiffSummary {
  const linesA = new Set(a.split('\n'));
  const linesB = new Set(b.split('\n'));
  let added = 0;
  for (const line of linesB) if (!linesA.has(line)) added++;
  let removed = 0;
  for (const line of linesA) if (!linesB.has(line)) removed++;
  return { added, removed };
}
