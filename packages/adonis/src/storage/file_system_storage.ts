import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CollabComment,
  CollaborationStorage,
  CollabVersion,
  PruneVersionsOptions,
} from '../types.js';
import { assertPruneKeep, versionsToPrune } from './shared.js';

/**
 * Disk storage for local development of the library (one file per doc +
 * one per version). In production use LucidStorage on top of Postgres.
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

  /** Document names on disk — one `<name>.bin` at the root per document. */
  private async documentNames(): Promise<string[]> {
    const entries = await readdir(this.baseDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.bin'))
      .map((entry) => decodeURIComponent(entry.name.slice(0, -'.bin'.length)));
  }

  async pruneVersions({ keep, docName, dryRun }: PruneVersionsOptions): Promise<number> {
    assertPruneKeep(keep);
    await this.ensure();
    const versionsDir = join(this.baseDir, 'versions');
    const files = await readdir(versionsDir).catch(() => []);

    // Version files carry no seq on disk, so recency is mtime and the owning
    // document is the longest name whose prefix matches — otherwise a doc
    // named 'a' would claim the versions of 'a_b'.
    const owners = (docName ? [docName] : await this.documentNames())
      .map((name) => ({ name, prefix: `${encodeURIComponent(name)}_` }))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    const perDocument = new Map<string, Array<{ file: string; seq: number }>>();
    for (const file of files) {
      const owner = owners.find((candidate) => file.startsWith(candidate.prefix));
      if (!owner) continue;
      const { mtimeMs } = await stat(join(versionsDir, file));
      const group = perDocument.get(owner.name) ?? [];
      group.push({ file, seq: mtimeMs });
      perDocument.set(owner.name, group);
    }

    let removed = 0;
    for (const group of perDocument.values()) {
      const doomed = versionsToPrune(group, keep);
      removed += doomed.length;
      if (dryRun) continue;
      for (const entry of doomed) {
        await unlink(join(versionsDir, entry.file));
      }
    }
    return removed;
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
