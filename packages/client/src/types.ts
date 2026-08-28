/**
 * Tipos do client. Cópias estruturais (types-only) dos contratos do server
 * pra manter os pacotes independentes.
 */
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import type * as Y from 'yjs';

/** Estado da conexão WebSocket com o sync engine. */
export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Resposta de GET /collaboration/token. */
export interface CollabTokenInfo {
  token: string;
  /** URL do WS (self-hosted: path relativo; partykit: origin remoto). */
  wsUrl: string;
  /** Engine informado pelo server (yjs | automerge | partykit). */
  engine: string;
}

/** Comentário persistido (espelho do CollabComment do server). */
export interface CollabComment {
  id: string;
  documentName: string;
  space: string;
  anchor:
    | { kind: 'text-range'; start: number; end: number; selectedText: string }
    | { kind: 'canvas-object'; shapeId: string; relativeX: number; relativeY: number }
    | { kind: 'timestamp'; at: number; end?: number };
  body: string;
  userId: string;
  authorName?: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** Versão registrada no histórico (espelho do CollabVersion). */
export interface CollabVersion {
  id: string;
  createdAt: string;
  createdBy: string | null;
  label: string | null;
  seq: number;
}

/** Peer presente num documento (metadados de awareness). */
export interface CollabPeer {
  clientId: number;
  userId?: string | undefined;
  name?: string | undefined;
  avatarUrl?: string | null;
}

/** Transporte mínimo sobre o engine escolhido pelo server. */
export interface CollabTransport {
  readonly doc: Y.Doc;
  /** Hocuspocus expõe Awareness | null; partykit sempre não-null. */
  readonly awareness?: AwarenessProtocol.Awareness | null;
  getStatus(): CollabStatus;
  /**
   * True once the server's initial state has been applied to the doc.
   *
   * Optional: `getStatus() === 'connected'` only says the socket is open.
   * Transports that can tell the two apart (Hocuspocus) implement this;
   * for the others the session falls back to the status.
   */
  isSynced?(): boolean;
  /** Assina mudanças de status; retorna unsubscribe. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/** Factory de transporte — injetável pra testes e engines custom. */
export type TransportFactory = (
  info: CollabTokenInfo,
  doc: Y.Doc,
  docName: string,
) => CollabTransport;

/** Config global do client (props do <CollaborationProvider>). */
export interface CollaborationClientConfig {
  /**
   * Base URL do server Adonis (ex.: https://api.app). Opcional: quando
   * omitida o client usa `location.origin`, que é o caso same-origin.
   */
  baseUrl?: string | undefined;
  /**
   * Headers anexados às chamadas REST (ex.: cookie/token de sessão).
   * Função pra suportar tokens que rotacionam.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Factory custom de transporte (tests / engines próprios). */
  createTransport?: TransportFactory;
  /** Override de fetch (testes/SSR). */
  fetchImpl?: typeof fetch;
}
