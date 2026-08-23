import type { WebSocket } from 'ws';
import type {
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

  /** Encerra graciosamente (flush + fecha conexões). */
  close(): Promise<void>;
}

/** Helpers compartilhados pelos drivers. */
export type { CollabConnectionContext, CollabPermission, CollabVersion, CollaborationConfig };
export type { CollabDiffSummary };
