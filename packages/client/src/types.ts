/**
 * Tipos do client. Cópias estruturais (types-only) dos contratos do server
 * pra manter os pacotes independentes.
 */
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import type * as Y from 'yjs';

/** Estado da conexão WebSocket com o sync engine. */
export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Resposta de GET /collaboration/token — e a forma de um token que o server
 * emitiu adiantado (`issueCollaborationToken`) e mandou junto com a página.
 */
export interface CollabTokenInfo {
  token: string;
  /** URL do WS (self-hosted: path relativo; partykit: origin remoto). */
  wsUrl: string;
  /** Engine informado pelo server (yjs | automerge | partykit). */
  engine: string;
  /**
   * Epoch em ms em que a credencial deixa de ser aceita. Toda engine reporta:
   * self-hosted e partykit emitem o MESMO formato assinado, com validade
   * curta (5 min). Antes o self-hosted era um base64 sem assinatura e sem
   * expiração — um token que nunca morria e que qualquer um podia forjar.
   *
   * Opcional porque um emissor customizado pode não ter validade a reportar;
   * nada que a lib emite vem sem ela.
   *
   * Só importa para um token pré-emitido: ele pode ficar no HTML enquanto a
   * aba estiver aberta, e o client precisa distinguir "já morreu" de "vale
   * tentar" sem abrir um socket pra descobrir.
   */
  expiresAt?: number | null | undefined;
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
  /**
   * Tokens que o server já emitiu para esta renderização, por docName.
   *
   * Corta o `GET /collaboration/token` do caminho crítico: o socket abre no
   * mount, sem esperar um round-trip para o mesmo servidor que renderizou a
   * página e já sabia a resposta.
   *
   * **Usado uma vez, na primeira conexão.** Toda reconexão volta a buscar um
   * token novo por HTTP — é assim que a expiração vira revogação, porque cada
   * reconexão re-executa `authorize`. Um token pré-emitido inválido ou já
   * expirado é ignorado e a sessão cai no fluxo HTTP normal.
   *
   * ```tsx
   * <CollaborationProvider initialTokens={{ [docName]: collabToken }}>
   * ```
   */
  initialTokens?: Record<string, CollabTokenInfo | null | undefined> | undefined;
}
