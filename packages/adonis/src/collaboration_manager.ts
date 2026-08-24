import type { CollaborationDriver } from './driver.js';
import { AutomergeDriver } from './drivers/automerge/automerge_driver.js';
import { YjsDriver } from './drivers/yjs/yjs_driver.js';
import { CommentService } from './services/comment_service.js';
import { type PresenceMember, PresenceService } from './services/presence_service.js';
import { InMemoryCollaborationStorage } from './storage/in_memory_storage.js';
import type { CollabComment, CollabDiffSummary, CollabVersion, CollaborationConfig } from './types.js';

/**
 * Fachada da lib: escolhe o driver pela config e expõe a API unificada
 * (documento + versões + presença + comentários) pro app hospedeiro.
 */
export class CollaborationManager {
  private driver: CollaborationDriver;
  presence: PresenceService;
  comments: CommentService;

  constructor(private config: CollaborationConfig) {
    this.driver =
      config.engine === 'automerge' ? new AutomergeDriver(config) : new YjsDriver(config);

    this.presence = new PresenceService(config.redis?.url);
    this.comments = new CommentService(config.storage ?? new InMemoryCollaborationStorage());
  }

  get engine(): string {
    return this.driver.engine;
  }

  /** Anexa o WebSocket do driver no server HTTP do Adonis. */
  async attach(server: import('node:http').Server): Promise<void> {
    await this.driver.attach(server);
  }

  /** Estado binário atual (pra push externo — Google Drive, export…). */
  getDocumentState(docName: string): Promise<Uint8Array> {
    return this.driver.getDocumentState(docName);
  }

  /** Texto plano (LanguageTool, RAG, índices de comentários). */
  getDocumentText(docName: string): Promise<string> {
    return this.driver.getDocumentText(docName);
  }

  createVersion(
    docName: string,
    createdBy: string | null,
    label?: string | null,
  ): Promise<CollabVersion> {
    return this.driver.createVersion(docName, createdBy, label ?? null);
  }

  listVersions(docName: string): Promise<CollabVersion[]> {
    return this.driver.listVersions(docName);
  }

  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void> {
    return this.driver.restoreVersion(docName, versionId, restoredBy);
  }

  diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    return this.driver.diffVersions(docName, aId, bId);
  }

  /** Membros online num documento (todas as instâncias). */
  listPresence(docName: string): PresenceMember[] {
    return this.presence.list(docName);
  }

  async close(): Promise<void> {
    await this.driver.close();
    await this.presence.close();
  }
}

export { YjsDriver, AutomergeDriver };
export type { CollaborationDriver, CollaborationConfig, PresenceMember };
