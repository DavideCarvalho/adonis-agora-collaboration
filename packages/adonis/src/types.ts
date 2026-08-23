/**
 * Tipos centrais da lib de colaboração.
 *
 * A abstração é document-first: um `CollabDocument` é identificado por nome
 * (`researches/<id>/writing`, por exemplo) e o driver escolhido decide como
 * sincronizar (Yjs/Hocuspocus ou Automerge). Tudo que depende do motor fica
 * atrás das interfaces — o app consome apenas `CollaborationManager`.
 */

/** Motor CRDT subjacente. */
export type CollaborationEngine = 'yjs' | 'automerge';

/** Payload de autenticação anexado à conexão WebSocket. */
export interface CollabConnectionContext {
  /** Id do usuário autenticado (o provider valida antes do handshake). */
  userId: string;
  /** Metadados livres (nome, avatar) pra presença. */
  user?: { name?: string; avatarUrl?: string | null };
}

/** Resultado da autorização de leitura/escrita de um documento. */
export interface CollabPermission {
  canRead: boolean;
  /** Escrever no conteúdo do documento (editor central). */
  canWrite: boolean;
  /** Comentar (annotations laterais — não muda o texto). */
  canComment: boolean;
}

/** Documento colaborativo carregado pelo driver. */
export interface LoadedCollabDocument {
  /** Estado binário completo pra enviar a um cliente novo (update merge). */
  state: Uint8Array;
  /** Vetor de estado pra sync diferencial (Yjs: state vector; Automerge: heads). */
  vector: Uint8Array;
}

/** Uma versão registrada no histórico do documento. */
export interface CollabVersion {
  /** Referência opaca pro driver (snapshot Yjs / hash Automerge). */
  id: string;
  createdAt: string;
  createdBy: string | null;
  label: string | null;
  /** Número sequencial amigável (1, 2, 3…). */
  seq: number;
}

/** Estatísticas de diff entre duas versões. */
export interface CollabDiffSummary {
  added: number;
  removed: number;
}

/**
 * Persistência de documentos + versões. O app hospedeiro implementa isso
 * (banco, S3…) e a lib só conhece a interface.
 */
export interface CollaborationStorage {
  loadDocument(docName: string): Promise<{ state: Uint8Array } | null>;
  saveDocument(docName: string, state: Uint8Array, meta?: Record<string, unknown>): Promise<void>;
  listVersions(docName: string): Promise<CollabVersion[]>;
  saveVersion(docName: string, version: CollabVersion, snapshot: Uint8Array): Promise<void>;
  loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null>;
}

/** Configuração do manager. */
export interface CollaborationConfig {
  engine: CollaborationEngine;
  /** Omitido = in-memory (só dev). O stub de config publica um default. */
  storage?: CollaborationStorage;
  /**
   * Autorização por documento. Chamada no handshake (onAuthenticate) e a cada
   * mudança de permissão relevante — retorna false pra derrubar a conexão.
   */
  authorize: (ctx: CollabConnectionContext, docName: string) => Promise<CollabPermission>;
  /** Redis pra presença cross-instance (opcional em dev single-instance). */
  redis?: { url: string };
  /** Porta/path do WS quando embutido no server HTTP do Adonis. */
  path?: string;
  /** Debounce de persistência em ms (default 2000). */
  debounce?: number;
}
