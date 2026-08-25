import type { Knex } from 'knex';
import type { CollabComment, CollabVersion, CollaborationStorage } from '../types.js';

/**
 * Contrato estrutural mínimo da conexão lucid — evita o dual-package do
 * @adonisjs/lucid (app e lib podem resolver cópias com TS diferentes).
 */
export interface LucidConnectionLike {
  connection(name?: string): unknown;
}

/**
 * Storage Lucid oficial — persiste docs (estado binário), versões e
 * comentários ancorados em tabelas do banco do app.
 *
 * As tabelas são criadas no primeiro uso (IF NOT EXISTS), então o app não
 * precisa de migration própria pra usar a lib em dev.
 *
 * @example
 * const storage = new LucidStorage(db)
 * const manager = new CollaborationManager({ engine: 'yjs', storage, authorize })
 */
export class LucidStorage implements CollaborationStorage {
  private ready: Promise<void> | null = null;

  constructor(private db: LucidConnectionLike, private connection: string = 'entretextos') {}

  /** Garante as tabelas sob demanda (lazy) — o boot não toca no banco. */
  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = this.ensureSchema();
    }
    return this.ready;
  }

  /** A conexão do lucid é um Knex (QueryClientContract estende o builder). */
  private knex(): Knex {
    return this.db.connection(this.connection) as unknown as Knex;
  }

  private async ensureSchema(): Promise<void> {
    const knex = this.knex();

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

    await Promise.all([schema, versions, comments]);
  }

  async loadDocument(docName: string): Promise<{ state: Uint8Array } | null> {
    await this.ensure();
    const row = await this.knex().from('collab_documents').where('doc_name', docName).first();
    if (!row?.state) return null;
    return { state: new Uint8Array(row.state as Buffer) };
  }

  async saveDocument(docName: string, state: Uint8Array, meta?: Record<string, unknown>): Promise<void> {
    await this.ensure();
    const existing = await this.knex()
      .from('collab_documents')
      .where('doc_name', docName)
      .first();
    const payload = {
      state: Buffer.from(state),
      meta: meta ?? null,
      updated_at: new Date(),
    };
    if (existing) {
      await this.knex().from('collab_documents').where('doc_name', docName).update(payload);
    } else {
      await this.knex().from('collab_documents').insert({
        doc_name: docName,
        ...payload,
        created_at: new Date(),
      });
    }
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    await this.ensure();
    const rows = await this.knex()
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

  async saveVersion(docName: string, version: CollabVersion, _snapshot: Uint8Array): Promise<void> {
    await this.ensure();
    await this.knex()
      .from('collab_versions')
      .insert({
        doc_name: docName,
        id: version.id,
        created_by: version.createdBy,
        label: version.label,
        seq: version.seq,
        created_at: new Date(version.createdAt),
      })
      .onConflict(['doc_name', 'id'])
      .ignore();
  }

  async loadVersionSnapshot(docName: string, _versionId: string): Promise<Uint8Array | null> {
    const doc = await this.loadDocument(docName);
    return doc?.state ?? null;
  }

  async listComments(docName: string, space?: string): Promise<CollabComment[]> {
    await this.ensure();
    let query = this.knex().from('collab_comments').where('doc_name', docName);
    if (space) query = query.where('space', space);
    const rows = await query;
    return rows.map((row) => ({
      id: row.id as string,
      documentName: row.doc_name as string,
      space: (row.space as string) ?? 'text',
      anchor: row.anchor as CollabComment['anchor'],
      body: row.body as string,
      userId: row.user_id as string,
      authorName: (row.author_name as string | null) ?? null,
      resolvedAt: (row.resolved_at as Date | null)?.toISOString?.() ?? row.resolved_at ?? null,
      createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
      updatedAt: (row.updated_at as Date | null)?.toISOString?.() ?? row.updated_at ?? null,
    }));
  }

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    await this.ensure();
    const existing = await this.knex().from('collab_comments').where('id', comment.id).first();
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
      await this.knex().from('collab_comments').where('id', comment.id).update(payload);
    } else {
      await this.knex().from('collab_comments').insert({
        id: comment.id,
        ...payload,
        created_at: new Date(comment.createdAt),
      });
    }
    void docName;
  }

  async deleteComment(docName: string, commentId: string): Promise<void> {
    await this.ensure();
    await this.knex().from('collab_comments').where('id', commentId).delete();
    void docName;
  }
}
