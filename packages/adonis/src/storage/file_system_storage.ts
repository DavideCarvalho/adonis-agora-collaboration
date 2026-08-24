import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollabComment, CollabVersion, CollaborationStorage } from '../types.js';

/**
 * Storage em disco pra desenvolvimento local da lib (um arquivo por doc +
 * um por versão). Em produção use o LucidStorage sobre Postgres.
 */
export class FileSystemStorage implements CollaborationStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), '.collab-data');
  }

  private async ensure(): Promise<void> {
    await mkdir(join(this.baseDir, 'versions'), { recursive: true });
    await mkdir(join(this.baseDir, 'comments'), { recursive: true });
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

  private commentsPath(docName: string): string {
    return join(this.baseDir, 'comments', `${encodeURIComponent(docName)}.json`);
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

  async listVersions(docName: string): Promise<CollabVersion[]> {
    void docName;
    return [];
  }

  async saveVersion(docName: string, _version: CollabVersion, snapshot: Uint8Array): Promise<void> {
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

  async listComments(docName: string, space?: string): Promise<CollabComment[]> {
    try {
      const content = await readFile(this.commentsPath(docName), 'utf-8');
      const all = JSON.parse(content) as CollabComment[];
      return space ? all.filter((comment) => comment.space === space) : all;
    } catch {
      return [];
    }
  }

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    await this.ensure();
    const existing = await this.listComments(docName);
    const index = existing.findIndex((entry) => entry.id === comment.id);
    if (index >= 0) {
      existing[index] = comment;
    } else {
      existing.push(comment);
    }
    await writeFile(this.commentsPath(docName), JSON.stringify(existing, null, 2));
  }

  async deleteComment(docName: string, commentId: string): Promise<void> {
    await this.ensure();
    const existing = await this.listComments(docName);
    await writeFile(
      this.commentsPath(docName),
      JSON.stringify(
        existing.filter((entry) => entry.id !== commentId),
        null,
        2,
      ),
    );
  }
}
