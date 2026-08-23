import type { CollabVersion, CollaborationStorage } from '../types.js';

/**
 * Storage em memória — fallback de desenvolvimento quando o app não configura
 * `storage` (nada sobrevive a um restart). Produção SEMPRE passa um storage
 * persistente (Postgres/S3).
 */
export class InMemoryCollaborationStorage implements CollaborationStorage {
  private docs = new Map<string, Uint8Array>();
  private versions = new Map<string, Array<{ version: CollabVersion; snapshot: Uint8Array }>>();

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
}
