import type { CollabComment, CollabVersion, CollaborationStorage } from '../types.js';

/**
 * Storage em memória — fallback de desenvolvimento quando o app não configura
 * `storage` (nada sobrevive a um restart). Produção SEMPRE passa um storage
 * persistente (Postgres/S3).
 */
export class InMemoryCollaborationStorage implements CollaborationStorage {
  private docs = new Map<string, Uint8Array>();
  private versions = new Map<string, Array<{ version: CollabVersion; snapshot: Uint8Array }>>();
  private comments = new Map<string, CollabComment[]>();

  async loadDocument(docName: string): Promise<{ state: Uint8Array } | null> {
    const state = this.docs.get(docName);
    return state ? { state } : null;
  }

  async saveDocument(docName: string, state: Uint8Array): Promise<void> {
    this.docs.set(docName, state);
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return (this.versions.get(docName) ?? []).map((entry) => entry.version);
  }

  async saveVersion(docName: string, version: CollabVersion, snapshot: Uint8Array): Promise<void> {
    if (!this.versions.has(docName)) {
      this.versions.set(docName, []);
    }
    this.versions.get(docName)!.push({ version, snapshot });
  }

  async loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null> {
    const entry = (this.versions.get(docName) ?? []).find((v) => v.version.id === versionId);
    return entry?.snapshot ?? null;
  }

  async listComments(docName: string, space?: string): Promise<CollabComment[]> {
    const all = this.comments.get(docName) ?? [];
    return space ? all.filter((comment) => comment.space === space) : all;
  }

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    const existing = this.comments.get(docName) ?? [];
    const index = existing.findIndex((entry) => entry.id === comment.id);
    if (index >= 0) {
      existing[index] = comment;
    } else {
      existing.push(comment);
    }
    this.comments.set(docName, existing);
  }

  async deleteComment(docName: string, commentId: string): Promise<void> {
    const existing = this.comments.get(docName) ?? [];
    this.comments.set(
      docName,
      existing.filter((entry) => entry.id !== commentId)
    );
  }
}
