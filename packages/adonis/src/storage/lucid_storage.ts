import type { Knex } from 'knex';
import type {
  CollabComment,
  CollaborationStorage,
  CollabVersion,
  PruneVersionsOptions,
} from '../types.js';
import { assertPruneKeep, versionsToPrune } from './shared.js';

/**
 * Minimal structural contract for the lucid connection — avoids the
 * dual-package issue of @adonisjs/lucid (app and library may resolve copies
 * with different TS versions).
 */
export interface LucidConnectionLike {
  connection(name?: string): unknown;
}

/** Ids deleted per statement by `pruneVersions` — keeps the IN (...) sane. */
const PRUNE_BATCH_SIZE = 500;

/**
 * Official Lucid storage — persists docs (binary state), versions and
 * anchored comments in tables of the app's database.
 *
 * Tables are created on first use (IF NOT EXISTS), so the app doesn't need
 * its own migration to use the library in dev.
 *
 * @example
 * const storage = new LucidStorage(db)
 * const manager = new CollaborationManager({ engine: 'yjs', storage, authorize })
 */
export class LucidStorage implements CollaborationStorage {
  private ready: Promise<void> | null = null;

  constructor(
    db?: LucidConnectionLike,
    private connection?: string,
  ) {
    // Tests pass a real or mocked db instance; if so, bypass lazy import.
    if (db) LucidStorage._db = db;
  }

  /** Ensures the tables lazily on demand — boot doesn't touch the database. */
  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = this.ensureSchema();
    }
    return this.ready;
  }

  private static _db: LucidConnectionLike | null = null;

  /** The lucid connection is a Knex instance (QueryClientContract extends the builder). */
  private async knex(): Promise<Knex> {
    if (!LucidStorage._db) {
      // Dynamic import em vez de static: o dbFacade do Lucid é *undefined* se
      // importado na eval do módulo (antes do provider do Lucid bootar). O
      // import dinâmico resolve no primeiro uso, quando o app já está bootado.
      const mod = await import('@adonisjs/lucid/services/db');
      LucidStorage._db = mod.default as unknown as LucidConnectionLike;
    }
    return LucidStorage._db.connection(this.connection) as unknown as Knex;
  }

  private async ensureSchema(): Promise<void> {
    const knex = await this.knex();

    const schema = knex.schema.createTableIfNotExists('collab_documents', (t) => {
      t.string('doc_name').primary();
      t.binary('state');
      t.jsonb('meta').nullable();
      t.timestamp('created_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true });
    });

    const versions = knex.schema.createTableIfNotExists('collab_versions', (t) => {
      t.string('doc_name');
      t.string('id');
      t.string('created_by').nullable();
      t.string('label').nullable();
      t.integer('seq');
      // The document's bytes at the moment the version was created — without
      // it a restore would replay the CURRENT state, which is a no-op.
      t.binary('snapshot').nullable();
      t.timestamp('created_at', { useTz: true });
      t.primary(['doc_name', 'id']);
    });

    const comments = knex.schema.createTableIfNotExists('collab_comments', (t) => {
      t.string('id').primary();
      t.string('doc_name');
      t.string('space').defaultTo('text');
      t.jsonb('anchor');
      t.text('body');
      t.string('user_id');
      t.string('author_name').nullable();
      t.timestamp('resolved_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true }).nullable();
      t.index(['doc_name', 'space']);
    });

    // `createTableIfNotExists` skips the CREATE TABLE when the table is there
    // but still emits its CREATE INDEX as a separate statement — which fails
    // ("relation already exists") for an app that ran the published
    // migrations. So only the builders for missing tables are executed; knex
    // builders are lazy, nothing runs until they are awaited.
    const present = await Promise.all([
      knex.schema.hasTable('collab_documents'),
      knex.schema.hasTable('collab_versions'),
      knex.schema.hasTable('collab_comments'),
    ]);
    await Promise.all([schema, versions, comments].filter((_, index) => !present[index]));
  }

  async loadDocument(docName: string): Promise<{ state: Uint8Array } | null> {
    await this.ensure();
    const row = await (await this.knex())
      .from('collab_documents')
      .where('doc_name', docName)
      .first();
    if (!row?.state) return null;
    return { state: new Uint8Array(row.state as Buffer) };
  }

  async saveDocument(
    docName: string,
    state: Uint8Array,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensure();
    const knex = await this.knex();
    const existing = await knex.from('collab_documents').where('doc_name', docName).first();
    const payload = {
      state: Buffer.from(state),
      meta: meta ?? null,
      updated_at: new Date(),
    };
    if (existing) {
      await knex.from('collab_documents').where('doc_name', docName).update(payload);
    } else {
      await knex.table('collab_documents').insert({
        doc_name: docName,
        ...payload,
        created_at: new Date(),
      });
    }
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    await this.ensure();
    const knex = await this.knex();
    const rows = await knex
      .from('collab_versions')
      .where('doc_name', docName)
      .orderBy('seq', 'asc');
    return rows.map((row) => ({
      id: row.id as string,
      createdBy: (row.created_by as string | null) ?? null,
      label: (row.label as string | null) ?? null,
      seq: row.seq as number,
      createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    }));
  }

  async saveVersion(docName: string, version: CollabVersion, snapshot: Uint8Array): Promise<void> {
    await this.ensure();
    await (await this.knex())
      .table('collab_versions')
      .insert({
        doc_name: docName,
        id: version.id,
        created_by: version.createdBy,
        label: version.label,
        seq: version.seq,
        snapshot: Buffer.from(snapshot),
        created_at: new Date(version.createdAt),
      })
      .onConflict(['doc_name', 'id'])
      .ignore();
  }

  async loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null> {
    await this.ensure();
    const row = await (await this.knex())
      .from('collab_versions')
      .where('doc_name', docName)
      .andWhere('id', versionId)
      .first();
    if (!row) return null;
    if (!row.snapshot) return (await this.loadDocument(docName))?.state ?? null;
    return new Uint8Array(row.snapshot as Buffer);
  }

  async pruneVersions({ keep, docName, dryRun }: PruneVersionsOptions): Promise<number> {
    assertPruneKeep(keep);
    await this.ensure();

    const knex = await this.knex();
    let query = knex.from('collab_versions').select('doc_name', 'id', 'seq');
    if (docName) query = query.where('doc_name', docName);
    const rows = (await query) as Array<{ doc_name: string; id: string; seq: number }>;

    const perDocument = new Map<string, Array<{ id: string; seq: number }>>();
    for (const row of rows) {
      const group = perDocument.get(row.doc_name) ?? [];
      group.push({ id: row.id, seq: row.seq });
      perDocument.set(row.doc_name, group);
    }

    let removed = 0;
    for (const [name, versions] of perDocument) {
      const doomed = versionsToPrune(versions, keep);
      if (doomed.length === 0) continue;
      if (dryRun) {
        removed += doomed.length;
        continue;
      }
      for (let index = 0; index < doomed.length; index += PRUNE_BATCH_SIZE) {
        const batch = doomed.slice(index, index + PRUNE_BATCH_SIZE).map((version) => version.id);
        removed += await knex
          .from('collab_versions')
          .where('doc_name', name)
          .whereIn('id', batch)
          .delete();
      }
    }
    return removed;
  }

  async listComments(docName: string, space?: string): Promise<CollabComment[]> {
    await this.ensure();
    const knex = await this.knex();
    let query = knex.from('collab_comments').where('doc_name', docName);
    if (space) query = query.where('space', space);
    const rows = await query;
    return rows.map((row) => this.toComment(row));
  }

  private toComment(row: Record<string, unknown>): CollabComment {
    return {
      id: row.id as string,
      documentName: row.doc_name as string,
      space: (row.space as string) ?? 'text',
      anchor: row.anchor as CollabComment['anchor'],
      body: row.body as string,
      userId: row.user_id as string,
      authorName: (row.author_name as string | null) ?? null,
      resolvedAt:
        (row.resolved_at as Date | null)?.toISOString?.() ??
        (row.resolved_at as string | null) ??
        null,
      createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
      updatedAt:
        (row.updated_at as Date | null)?.toISOString?.() ??
        (row.updated_at as string | null) ??
        null,
    };
  }

  /**
   * Indexed single-row lookup — the reason {@link CollaborationStorage.getComment}
   * exists. The permission check on a comment mutation used to read every
   * comment on the document to find one.
   */
  async getComment(docName: string, commentId: string): Promise<CollabComment | null> {
    await this.ensure();
    const knex = await this.knex();
    const row = await knex
      .from('collab_comments')
      .where('doc_name', docName)
      .where('id', commentId)
      .first();
    if (!row) return null;
    return this.toComment(row);
  }

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    await this.ensure();
    const knex = await this.knex();
    const existing = await knex.from('collab_comments').where('id', comment.id).first();
    const payload = {
      doc_name: comment.documentName,
      space: comment.space,
      anchor: comment.anchor,
      body: comment.body,
      user_id: comment.userId,
      author_name: comment.authorName ?? null,
      resolved_at: comment.resolvedAt ? new Date(comment.resolvedAt) : null,
      updated_at: new Date(),
    };
    if (existing) {
      await knex.from('collab_comments').where('id', comment.id).update(payload);
    } else {
      await knex.table('collab_comments').insert({
        id: comment.id,
        ...payload,
        created_at: new Date(comment.createdAt),
      });
    }
    void docName;
  }

  async deleteComment(docName: string, commentId: string): Promise<void> {
    await this.ensure();
    await (await this.knex()).from('collab_comments').where('id', commentId).delete();
    void docName;
  }
}

/**
 * Factory para config — o `LucidStorage` agora resolve o fachada do Lucid
 * LAZY (import dinâmico no primeiro `ensure()`), então o config pode chamá-lo
 * sem se preocupar com a ordem de boot dos providers.
 *
 * @example
 * // config/collaboration.ts
 * storage: lucidStorage({ connection: 'entretextos' })
 */
export function lucidStorage(options: { connection?: string } = {}): LucidStorage {
  return new LucidStorage(undefined, options.connection);
}
