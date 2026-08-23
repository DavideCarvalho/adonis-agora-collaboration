import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollaborationStorage } from '@adonis-agora/collaboration/types';

/**
 * Storage em disco pra desenvolvimento local da lib (um arquivo por doc +
 * um por versão). Em produção o app hospedeiro implementa CollaborationStorage
 * sobre Postgres/S3 — esta implementação é só pro `pnpm dev` da lib.
 */
export class FileSystemStorage implements CollaborationStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), '.collab-data');
  }

  private async ensure(): Promise<void> {
    await mkdir(join(this.baseDir, 'versions'), { recursive: true });
  }

  private docPath(docName: string): string {
    return join(this.baseDir, `${encodeURIComponent(docName)}.bin`);
  }

  private versionPath(docName: string, versionId: string): string {
    return join(
      this.baseDir,
      'versions',
      `${encodeURIComponent(docName)}_${encodeURIComponent(versionId)}.bin`,
    );
  }

  async loadDocument(docName: string): Promise<{ state: Uint8Array } | null> {
    try {
      const content = await readFile(this.docPath(docName));
      return { state: new Uint8Array(content) };
    } catch {
      return null;
    }
  }

  async saveDocument(docName: string, state: Uint8Array): Promise<void> {
    await this.ensure();
    await writeFile(this.docPath(docName), state);
  }

  async listVersions(
    docName: string,
  ): Promise<import('@adonis-agora/collaboration/types').CollabVersion[]> {
    // O FS storage não mantém metadados (só snapshots); versões reais ficam
    // no storage do app. Retorna vazio.
    return [];
  }

  async saveVersion(
    docName: string,
    _version: import('@adonis-agora/collaboration/types').CollabVersion,
    snapshot: Uint8Array,
  ): Promise<void> {
    await this.ensure();
    await writeFile(this.versionPath(docName, _version.id), snapshot);
  }

  async loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null> {
    try {
      const content = await readFile(this.versionPath(docName, versionId));
      return new Uint8Array(content);
    } catch {
      return null;
    }
  }
}
