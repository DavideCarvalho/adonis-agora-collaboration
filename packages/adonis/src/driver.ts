import type { WebSocket } from 'ws';
import type {
  CollabComment,
  CollabConnectionContext,
  CollabDiffSummary,
  CollabPermission,
  CollabVersion,
  CollaborationConfig,
} from './types.js';

/**
 * Contrato de um driver CRDT. O driver é dono do motor (Yjs/Hocuspocus ou
 * Automerge): recebe o server HTTP do Adonis pra anexar o WebSocket, fala o
 * protocolo binário do motor com os clientes e implementa version control
 * (nativo no Automerge, via snapshots no Yjs).
 */
export interface CollaborationDriver {
  readonly engine: string;

  /** Anexa o transporte WebSocket ao server HTTP (upgrade no path configurado). */
  attach(server: import('node:http').Server): Promise<void>;

  /** Estado binário atual do documento (pra export/push externo, ex.: Drive). */
  getDocumentState(docName: string): Promise<Uint8Array>;

  /** Texto plano do documento (pra LanguageTool, RAG, índices de comentário). */
  getDocumentText(docName: string): Promise<string>;

  /** Cria uma versão nomeada no histórico. */
  createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion>;

  /** Lista as versões do histórico. */
  listVersions(docName: string): Promise<CollabVersion[]>;

  /** Restaura o documento pra uma versão (cria nova versão "restaurado de X"). */
  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void>;

  /** Resumo de diff entre duas versões. */
  diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary>;

  /** Comentários ancorados do documento (por espaço opcional). */
  listComments(docName: string, space?: string): Promise<CollabComment[]>;

  /** Cria um comentário ancorado num espaço do documento. */
  createComment(
    docName: string,
    comment: Omit<CollabComment, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
  ): Promise<CollabComment>;

  /** Resolve/reabre um comentário. Retorna null se não existir. */
  resolveComment(docName: string, commentId: string, resolved: boolean): Promise<CollabComment | null>;

  /** Remove um comentário. Retorna false se não existir. */
  deleteComment(docName: string, commentId: string): Promise<boolean>;

  /** Encerra graciosamente (flush + fecha conexões). */
  close(): Promise<void>;
}

/**
 * Camada de comentários ancorados — genérica por tipo de conteúdo.
 * A lib persiste âncoras + lifecycle; o app registra o resolver do seu
 * formato (texto, canvas/tldraw, mídia).
 */
export interface CommentService {
  list(docName: string, space?: string): Promise<CollabComment[]>;
  create(
    docName: string,
    comment: Omit<CollabComment, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
  ): Promise<CollabComment>;
  resolve(docName: string, commentId: string, resolved: boolean): Promise<CollabComment | null>;
  remove(docName: string, commentId: string): Promise<boolean>;
}

/** Helpers compartilhados pelos drivers. */
export type {
  CollabComment,
  CollabConnectionContext,
  CollabPermission,
  CollabVersion,
  CollaborationConfig,
};
export type { CollabDiffSummary };
