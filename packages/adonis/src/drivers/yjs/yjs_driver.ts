import { Hocuspocus, type onAuthenticatePayload } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { CollaborationDriver } from '../../driver.js';
import { CommentService } from '../../services/comment_service.js';
import { InMemoryCollaborationStorage } from '../../storage/in_memory_storage.js';
import type {
  CollabComment,
  CollabDiffSummary,
  CollabPermission,
  CollabVersion,
  CollaborationConfig,
} from '../../types.js';
import { createVersionMetadata, seqVersions } from '../../versioning.js';

/**
 * Driver Yjs: Hocuspocus como engine de sync (protocolo y-protocols sobre
 * WebSocket), com version control implementado em cima de updates binários
 * completos — o que o Automerge tem nativo (history) a gente provê aqui:
 *
 *  - `createVersion`: guarda o update binário completo + metadados;
 *  - `restoreVersion`: aplica o conteúdo da versão no doc vivo via transação
 *    — clientes conectados recebem em tempo real pelo protocolo de sync;
 *  - `diffVersions`: materializa as duas versões e compara por linha.
 *  - Comentários ancorados: delegam pro CommentService (anchor genérica).
 */

/** Permissões por conexão (userId:docName), preenchidas no authenticate. */
const permissions = new Map<string, CollabPermission>();

export class YjsDriver implements CollaborationDriver {
  readonly engine = 'yjs';

  private hocuspocus: Hocuspocus;
  private wss?: WebSocketServer;
  private config: CollaborationConfig;
  private commentsService: CommentService;
  #memoryStorage?: InMemoryCollaborationStorage;

  /** Storage configurado ou in-memory (dev). */
  #storage() {
    if (this.config.storage) {
      return this.config.storage;
    }
    this.#memoryStorage ??= new InMemoryCollaborationStorage();
    return this.#memoryStorage;
  }

  constructor(config: CollaborationConfig) {
    this.config = config;
    this.commentsService = new CommentService(config.storage ?? new InMemoryCollaborationStorage());

    // Capturados fora do callback: o `this` dentro dos hooks do Hocuspocus
    // não é a instância do driver.
    const storage = () => this.#storage();

    this.hocuspocus = new Hocuspocus({
      async onAuthenticate({ documentName, token }: onAuthenticatePayload) {
        const ctx = JSON.parse(Buffer.from(token, 'base64').toString()) as {
          userId: string;
          user?: { name?: string; avatarUrl?: string | null };
        };
        const permission = await config.authorize(ctx, documentName);
        if (!permission.canRead) {
          throw new Error('Sem acesso a este documento');
        }
        permissions.set(`${ctx.userId}:${documentName}`, permission);
      },

      async onStoreDocument({ documentName, document }) {
        await storage().saveDocument(documentName, Y.encodeStateAsUpdate(document));
      },

      debounce: config.debounce ?? 2000,
    });
  }

  private liveDoc(name: string): Y.Doc | undefined {
    // Document do Hocuspocus estende Y.Doc diretamente.
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

    const stored = await this.#storage().loadDocument(name);
    return this.hydrate(stored?.state ?? new Uint8Array());
  }

  async attach(server: import('node:http').Server): Promise<void> {
    const path = this.config.path ?? '/collaboration';
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const parsed = new URL(request.url ?? '/', 'http://localhost');
      if (parsed.pathname !== path) return;

      wss.handleUpgrade(request, socket as import('node:net').Socket, head, (ws) => {
        // O Hocuspocus espera um Request da Fetch API; convertemos o
        // IncomingMessage do node pra um Request mínimo com a URL real.
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
    const stored = await this.#storage().loadDocument(docName);
    return stored?.state ?? new Uint8Array();
  }

  async getDocumentText(docName: string): Promise<string> {
    const doc = await this.ensureDoc(docName);

    try {
      const json = TiptapTransformer.fromYdoc(doc) as unknown as Record<string, unknown>;
      const defaultDoc = (json as { default?: Record<string, unknown> }).default ?? json;
      return tiptapJsonToText(defaultDoc);
    } catch {
      // Doc vazio ou fora do layout Tiptap.
      return '';
    }
  }

  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    const doc = await this.ensureDoc(docName);
    const existing = await this.#storage().listVersions(docName);
    const version = createVersionMetadata(createdBy, label, seqVersions(existing));

    await this.#storage().saveVersion(docName, version, Y.encodeStateAsUpdate(doc));
    return version;
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return this.#storage().listVersions(docName);
  }

  async restoreVersion(
    docName: string,
    versionId: string,
    restoredBy: string | null,
  ): Promise<void> {
    void restoredBy;

    const state = await this.versionState(docName, versionId);
    const restoredDoc = this.hydrate(state);

    // Aplica o conteúdo restaurado no doc vivo — clientes conectados recebem
    // a mudança em tempo real via protocolo de sync do Hocuspocus.
    const live = await this.ensureDoc(docName);
    live.transact(() => {
      applyRestoredContent(live, restoredDoc);
    });

    await this.#storage().saveDocument(docName, Y.encodeStateAsUpdate(live));
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aState, bState] = await Promise.all([
      this.versionState(docName, aId),
      this.versionState(docName, bId),
    ]);

    const textA = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(aState)));
    const textB = tiptapJsonToText(safeTiptapFromYdoc(this.hydrate(bState)));

    return simpleLineDiff(textA, textB);
  }

  private async versionState(docName: string, versionId: string): Promise<Uint8Array> {
    const persisted = await this.#storage().loadVersionSnapshot(docName, versionId);
    if (!persisted) throw new Error(`Versão ${versionId} não encontrada`);
    return persisted;
  }

  /* ───────────────────────── comentários ancorados ───────────────────────── */

  async listComments(docName: string, space?: string): Promise<CollabComment[]> {
    return this.commentsService.list(docName, space);
  }

  async createComment(
    docName: string,
    comment: Omit<CollabComment, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
  ): Promise<CollabComment> {
    return this.commentsService.create(docName, comment);
  }

  async resolveComment(
    docName: string,
    commentId: string,
    resolved: boolean,
  ): Promise<CollabComment | null> {
    return this.commentsService.resolve(docName, commentId, resolved);
  }

  async deleteComment(docName: string, commentId: string): Promise<boolean> {
    return this.commentsService.remove(docName, commentId);
  }

  async close(): Promise<void> {
    // Persiste docs pendentes e fecha conexões (a classe Hocuspocus não tem
    // destroy — o Server embutido é que tem).
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    return new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
  }
}

/* ───────────────────────── helpers locais ───────────────────────── */

function safeTiptapFromYdoc(doc: Y.Doc): Record<string, unknown> {
  try {
    return TiptapTransformer.fromYdoc(doc) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Converte o JSON Tiptap em texto plano (\n\n entre blocos). */
export function tiptapJsonToText(node: Record<string, unknown> | null): string {
  if (!node || !Array.isArray(node.content)) return '';

  let text = '';
  const walk = (current: Record<string, unknown>) => {
    if (current.type === 'text' && typeof current.text === 'string') {
      text += current.text;
      return;
    }
    if (Array.isArray(current.content)) {
      for (const child of current.content as Array<Record<string, unknown>>) {
        walk(child);
      }
    }
    if (
      typeof current.type === 'string' &&
      ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'].includes(current.type)
    ) {
      text += '\n\n';
    }
  };
  walk(node);
  return text.trimEnd();
}

/** Diff por linha simples o suficiente pra resumo (+adicionadas / -removidas). */
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
 * Substitui o conteúdo do doc vivo aplicando o update completo do doc
 * restaurado (merge CRDT é idempotente; o delete anterior remove o estado
 * divergente e o update traz o conteúdo antigo de volta).
 */
function applyRestoredContent(live: Y.Doc, restored: Y.Doc): void {
  const liveFragment = live.getXmlFragment('default');
  liveFragment.delete(0, liveFragment.length);

  const update = Y.encodeStateAsUpdate(restored);
  Y.applyUpdate(live, update);
}
