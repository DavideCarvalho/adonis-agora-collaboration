import type { Knex } from 'knex';
import type {
  CollabComment,
  CollaborationStorage,
  CollabVersion,
  ListPageOptions,
  PruneVersionsOptions,
} from '../types.js';
import {
  CodecStorage,
  isBinaryEnvelope,
  isEncodedAnchor,
  isTextEnvelope,
  type StorageCodec,
  StorageCodecRunner,
} from './codec.js';
import { assertPruneKeep, resolvePage, versionsToPrune } from './shared.js';

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

/** The tables `LucidStorage` owns. */
export const COLLAB_TABLES = ['collab_documents', 'collab_versions', 'collab_comments'] as const;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Throws unless `schema` is a plain identifier of at most 63 characters —
 * it ends up in SQL as an identifier.
 */
export function assertSchemaName(schema: string): void {
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema) || schema.length > 63) {
    throw new Error(
      `[@adonis-agora/collaboration] invalid schema ${JSON.stringify(schema)} ` +
        '(letters, digits, _ and $, not starting with a digit, at most 63 characters)',
    );
  }
}

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'other';

function dialectOf(name: string | undefined): Dialect {
  if (!name) return 'other';
  if (/postgres|pg|redshift/i.test(name)) return 'postgres';
  if (/mysql|maria/i.test(name)) return 'mysql';
  if (/sqlite|libsql/i.test(name)) return 'sqlite';
  return 'other';
}

/** Options of {@link lucidStorage}. */
export interface LucidStorageOptions {
  /** Lucid connection name. Default: the default connection. */
  connection?: string | undefined;
  /**
   * Postgres schema (MySQL: database) holding the tables. Every query names
   * it (`"collab"."collab_documents"`), so nothing depends on the connection's
   * `search_path`, and the first use creates it when missing. Default: the
   * connection's current schema.
   */
  schema?: string | undefined;
  /**
   * Encodes (typically encrypts) what is stored: document state, version
   * snapshots, comment bodies and anchors. Rows written before it was set
   * keep loading as plaintext and are encoded on their next save, or all at
   * once with {@link LucidStorage.reencodeAll}.
   */
  codec?: StorageCodec | undefined;
}

/** Options of {@link LucidStorage.reencodeAll}. */
export interface ReencodeOptions {
  /** Rows read per query. Default 100. */
  batchSize?: number;
  /** Count what would be encoded without writing. */
  dryRun?: boolean;
  /** Called after each batch. */
  onProgress?: (progress: ReencodeResult) => void;
}

/** What {@link LucidStorage.reencodeAll} encoded (or would encode, with `dryRun`). */
export interface ReencodeResult {
  documents: number;
  versions: number;
  comments: number;
}

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
  private readonly connection: string | undefined;
  /** The schema (MySQL: database) holding the tables, or undefined for the current one. */
  readonly schema: string | undefined;
  private readonly codec: StorageCodecRunner | undefined;

  constructor(db?: LucidConnectionLike, options?: string | LucidStorageOptions) {
    // Tests pass a real or mocked db instance; if so, bypass lazy import.
    if (db) LucidStorage._db = db;
    const opts = typeof options === 'string' ? { connection: options } : (options ?? {});
    if (opts.schema !== undefined) assertSchemaName(opts.schema);
    this.connection = opts.connection;
    this.schema = opts.schema;
    this.codec = opts.codec ? new StorageCodecRunner(opts.codec) : undefined;
  }

  /** True when a codec is configured. */
  get hasCodec(): boolean {
    return this.codec !== undefined;
  }

  /** Ensures the tables lazily on demand — boot doesn't touch the database. */
  private ensure(): Promise<void> {
    if (!this.ready) {
      // A failed attempt (database down, missing grant) is retried next time.
      this.ready = this.ensureSchema().catch((error: unknown) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  /** `table` as the query builder should name it: `schema.table` when a schema is set. */
  private t(table: (typeof COLLAB_TABLES)[number]): string {
    return this.schema ? `${this.schema}.${table}` : table;
  }

  /** A schema builder bound to the configured schema. */
  private schemaBuilder(knex: Knex): Knex.SchemaBuilder {
    return this.schema ? knex.schema.withSchema(this.schema) : knex.schema;
  }

  private async dialect(): Promise<Dialect> {
    const client = (await this.knex()) as unknown as { dialect?: { name?: string } };
    return dialectOf(client.dialect?.name);
  }

  /**
   * Fails when `schema` is set on a connection that has no schemas (SQLite).
   * Reads the connection config only; no query is sent. The provider calls it
   * when the app boots.
   */
  async assertSchemaSupported(): Promise<void> {
    if (this.schema === undefined) return;
    if ((await this.dialect()) === 'sqlite') {
      throw new Error(
        `[@adonis-agora/collaboration] lucidStorage({ schema: '${this.schema}' }) needs Postgres or MySQL; ` +
          'SQLite has no schemas. Remove `schema`, or point `connection` at a Postgres/MySQL connection.',
      );
    }
  }

  private async schemaExists(knex: Knex): Promise<boolean> {
    const rows = await knex
      .from('information_schema.schemata')
      .select('schema_name')
      .where('schema_name', this.schema as string);
    return (rows as unknown[]).length > 0;
  }

  private async createSchema(knex: Knex): Promise<void> {
    const schema = this.schema as string;
    if (await this.schemaExists(knex)) return;
    const dialect = await this.dialect();
    const statement =
      dialect === 'mysql'
        ? `CREATE DATABASE IF NOT EXISTS \`${schema}\``
        : `CREATE SCHEMA IF NOT EXISTS "${schema}"`;
    try {
      // A Lucid client's `raw()` only builds a fragment; `rawQuery()` runs it.
      const client = knex as unknown as { rawQuery?(sql: string): Promise<unknown> };
      await (client.rawQuery ? client.rawQuery(statement) : knex.raw(statement));
    } catch (error) {
      // Another process may have created it between the check and the CREATE.
      if (await this.schemaExists(knex).catch(() => false)) return;
      throw new Error(
        `[@adonis-agora/collaboration] could not create the ${dialect === 'mysql' ? 'database' : 'schema'} ` +
          `"${schema}" (${error instanceof Error ? error.message : String(error)}). Create it yourself ` +
          `(${statement}) or let the database role create it ` +
          (dialect === 'mysql'
            ? '(GRANT CREATE ON *.* TO <user>).'
            : '(GRANT CREATE ON DATABASE <database> TO <role>).'),
        { cause: error },
      );
    }
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
    if (this.schema !== undefined) {
      await this.assertSchemaSupported();
      await this.createSchema(knex);
    }

    const schema = this.schemaBuilder(knex).createTableIfNotExists('collab_documents', (t) => {
      t.string('doc_name').primary();
      t.binary('state');
      t.jsonb('meta').nullable();
      t.timestamp('created_at', { useTz: true });
      t.timestamp('updated_at', { useTz: true });
    });

    const versions = this.schemaBuilder(knex).createTableIfNotExists('collab_versions', (t) => {
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

    const comments = this.schemaBuilder(knex).createTableIfNotExists('collab_comments', (t) => {
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
    const tablesPresent = () =>
      Promise.all([
        this.schemaBuilder(knex).hasTable('collab_documents'),
        this.schemaBuilder(knex).hasTable('collab_versions'),
        this.schemaBuilder(knex).hasTable('collab_comments'),
      ]);
    const present = await tablesPresent();
    const results = await Promise.allSettled(
      [schema, versions, comments].filter((_, index) => !present[index]),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (!failed) return;
    // Another process creating the same tables at the same moment makes one of
    // the two CREATEs (or its CREATE INDEX) fail. Give it a moment to finish.
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await tablesPresent()).every(Boolean)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw failed.reason;
  }

  async loadDocument(
    docName: string,
  ): Promise<{ state: Uint8Array; meta: Record<string, unknown> | null } | null> {
    await this.ensure();
    const row = await (await this.knex())
      .from(this.t('collab_documents'))
      .select('state', 'meta')
      .where('doc_name', docName)
      .first();
    const meta = parseMeta(row?.meta);
    if (!row?.state || (row.state as Buffer).byteLength === 0) {
      this.codec?.markReadable(docName);
      return null;
    }
    const stored = new Uint8Array(row.state as Buffer);
    const state = this.codec ? await this.codec.decodeDocument(stored, docName, meta) : stored;
    return { state, meta };
  }

  /**
   * Lets the next save overwrite a document whose stored state failed to
   * decode in this process. Only for when losing that state is intended.
   */
  forgetDecodeFailure(docName: string): void {
    this.codec?.markReadable(docName);
  }

  async saveDocument(
    docName: string,
    state: Uint8Array,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    this.codec?.assertWritable(docName);
    await this.ensure();
    const stored = this.codec
      ? await this.codec.encodeBinary(state, {
          docName,
          kind: 'document',
          field: 'state',
          ...(meta !== undefined ? { meta } : {}),
        })
      : state;
    const knex = await this.knex();
    const now = new Date();
    // Single upsert instead of a SELECT to decide insert-vs-update: the old
    // shape ran two round-trips per save, on every debounce flush of every
    // actively-edited document. `doc_name` is the table's primary key (see
    // `ensureSchema`/the published migration), so it is the only possible
    // conflict target. `created_at` is deliberately left out of `.merge()` —
    // an update must not look like the row was created just now.
    await knex
      .table(this.t('collab_documents'))
      .insert({
        doc_name: docName,
        state: Buffer.from(stored),
        meta: meta ?? null,
        created_at: now,
        updated_at: now,
      })
      .onConflict('doc_name')
      .merge(['state', 'meta', 'updated_at']);
  }

  async listVersions(docName: string, page?: ListPageOptions): Promise<CollabVersion[]> {
    await this.ensure();
    const knex = await this.knex();
    // Only the metadata columns: `collab_versions` also holds every snapshot,
    // and a bare select shipped all of them (tens of MB for a long history)
    // just to map them away — on every listing, and on every `createVersion`,
    // which lists to find the next `seq`.
    let query = knex
      .from(this.t('collab_versions'))
      .select('id', 'created_by', 'label', 'seq', 'created_at')
      .where('doc_name', docName)
      .orderBy('seq', page?.order === 'desc' ? 'desc' : 'asc');
    // `page` is opt-in: internal callers computing the next `seq` or a
    // restore target need every version, and only pass none. The HTTP route
    // always passes one, which is what keeps a long history from coming back
    // as one ever-growing JSON array.
    if (page) {
      // `{ page, size }` in, `LIMIT/OFFSET` out: the 0-based offset is computed
      // here from the 1-based page rather than being asked of the caller.
      const { size, offset } = resolvePage(page);
      query = query.limit(size).offset(offset);
    }
    const rows = await query;
    return rows.map((row) => ({
      id: row.id as string,
      createdBy: (row.created_by as string | null) ?? null,
      label: (row.label as string | null) ?? null,
      seq: row.seq as number,
      createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    }));
  }

  async countVersions(docName: string): Promise<number> {
    await this.ensure();
    const row = await (await this.knex())
      .from(this.t('collab_versions'))
      .where('doc_name', docName)
      .count({ total: '*' })
      .first();
    return Number(row?.total ?? 0);
  }

  async saveVersion(docName: string, version: CollabVersion, snapshot: Uint8Array): Promise<void> {
    await this.ensure();
    const stored = this.codec
      ? await this.codec.encodeBinary(snapshot, {
          docName,
          kind: 'version',
          field: 'snapshot',
          versionId: version.id,
        })
      : snapshot;
    await (await this.knex())
      .table(this.t('collab_versions'))
      .insert({
        doc_name: docName,
        id: version.id,
        created_by: version.createdBy,
        label: version.label,
        seq: version.seq,
        snapshot: Buffer.from(stored),
        created_at: new Date(version.createdAt),
      })
      .onConflict(['doc_name', 'id'])
      .ignore();
  }

  async loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null> {
    await this.ensure();
    const row = await (await this.knex())
      .from(this.t('collab_versions'))
      .where('doc_name', docName)
      .andWhere('id', versionId)
      .first();
    if (!row) return null;
    if (!row.snapshot) return (await this.loadDocument(docName))?.state ?? null;
    const stored = new Uint8Array(row.snapshot as Buffer);
    if (!this.codec || stored.byteLength === 0) return stored;
    return this.codec.decodeBinary(stored, {
      docName,
      kind: 'version',
      field: 'snapshot',
      versionId,
    });
  }

  async pruneVersions({ keep, docName, dryRun }: PruneVersionsOptions): Promise<number> {
    assertPruneKeep(keep);
    await this.ensure();

    const knex = await this.knex();
    let query = knex.from(this.t('collab_versions')).select('doc_name', 'id', 'seq');
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
          .from(this.t('collab_versions'))
          .where('doc_name', name)
          .whereIn('id', batch)
          .delete();
      }
    }
    return removed;
  }

  async listComments(
    docName: string,
    space?: string,
    page?: ListPageOptions,
  ): Promise<CollabComment[]> {
    await this.ensure();
    const knex = await this.knex();
    let query = knex
      .from(this.t('collab_comments'))
      .where('doc_name', docName)
      .orderBy('created_at', page?.order === 'desc' ? 'desc' : 'asc');
    if (space) query = query.where('space', space);
    // Same opt-in pagination as `listVersions` — see the comment there.
    if (page) {
      const { size, offset } = resolvePage(page);
      query = query.limit(size).offset(offset);
    }
    const rows = await query;
    return Promise.all(rows.map((row) => this.toComment(row)));
  }

  async countComments(docName: string, space?: string): Promise<number> {
    await this.ensure();
    let query = (await this.knex()).from(this.t('collab_comments')).where('doc_name', docName);
    if (space) query = query.where('space', space);
    const row = await query.count({ total: '*' }).first();
    return Number(row?.total ?? 0);
  }

  private async toComment(row: Record<string, unknown>): Promise<CollabComment> {
    const comment = this.rowToComment(row);
    return this.codec ? this.codec.decodeComment(comment) : comment;
  }

  private rowToComment(row: Record<string, unknown>): CollabComment {
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
      .from(this.t('collab_comments'))
      .where('doc_name', docName)
      .where('id', commentId)
      .first();
    if (!row) return null;
    return this.toComment(row);
  }

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    await this.ensure();
    const stored = this.codec ? await this.codec.encodeComment(comment) : comment;
    const knex = await this.knex();
    const payload = {
      doc_name: comment.documentName,
      space: comment.space,
      anchor: stored.anchor,
      body: stored.body,
      user_id: comment.userId,
      author_name: comment.authorName ?? null,
      resolved_at: comment.resolvedAt ? new Date(comment.resolvedAt) : null,
      updated_at: new Date(),
    };
    // Same single-upsert shape as `saveDocument` — `id` is the table's primary
    // key, and `created_at` is excluded from `.merge()` so an edit does not
    // reset when the comment was created.
    await knex
      .table(this.t('collab_comments'))
      .insert({
        id: comment.id,
        ...payload,
        created_at: new Date(comment.createdAt),
      })
      .onConflict('id')
      .merge(Object.keys(payload));
    void docName;
  }

  async deleteComment(docName: string, commentId: string): Promise<void> {
    await this.ensure();
    await (await this.knex()).from(this.t('collab_comments')).where('id', commentId).delete();
    void docName;
  }

  /**
   * Encodes every row written before the codec was configured, in batches.
   * Rows already encoded are skipped, so it can be stopped and run again. A
   * row that changes while it is being encoded is left alone (its new value
   * was written through the codec). Throws without a codec.
   */
  async reencodeAll(options: ReencodeOptions = {}): Promise<ReencodeResult> {
    const codec = this.codec;
    if (!codec) {
      throw new Error(
        '[@adonis-agora/collaboration] reencodeAll needs lucidStorage({ codec }) — there is nothing to encode with',
      );
    }
    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        `[@adonis-agora/collaboration] reencodeAll requires a positive integer batchSize — received ${String(batchSize)}`,
      );
    }
    await this.ensure();
    const knex = await this.knex();
    const result: ReencodeResult = { documents: 0, versions: 0, comments: 0 };
    const report = () => options.onProgress?.({ ...result });

    // Documents, keyset-paged by primary key.
    let after: string | undefined;
    for (;;) {
      let query = knex
        .from(this.t('collab_documents'))
        .select('doc_name', 'state', 'meta')
        .orderBy('doc_name', 'asc')
        .limit(batchSize);
      if (after !== undefined) query = query.where('doc_name', '>', after);
      const rows = (await query) as Array<{
        doc_name: string;
        state: Buffer | null;
        meta: unknown;
      }>;
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.doc_name;
      for (const row of rows) {
        if (!row.state || row.state.byteLength === 0 || isBinaryEnvelope(row.state)) continue;
        const meta = parseMeta(row.meta);
        const ctx = { docName: row.doc_name, kind: 'document', field: 'state', meta } as const;
        const plain = await codec.decodeBinary(new Uint8Array(row.state), ctx);
        result.documents++;
        if (options.dryRun) continue;
        const encoded = await codec.encodeBinary(plain, ctx);
        await knex
          .from(this.t('collab_documents'))
          .where('doc_name', row.doc_name)
          .where('state', row.state)
          .update({ state: Buffer.from(encoded) });
      }
      report();
    }

    // Versions, keyset-paged by (doc_name, id).
    let cursor: { doc_name: string; id: string } | undefined;
    for (;;) {
      let query = knex
        .from(this.t('collab_versions'))
        .select('doc_name', 'id', 'snapshot')
        .orderBy([
          { column: 'doc_name', order: 'asc' },
          { column: 'id', order: 'asc' },
        ])
        .limit(batchSize);
      if (cursor) {
        const { doc_name: doc, id } = cursor;
        query = query.where((q) =>
          q
            .where('doc_name', '>', doc)
            .orWhere((inner) => inner.where('doc_name', doc).where('id', '>', id)),
        );
      }
      const rows = (await query) as Array<{
        doc_name: string;
        id: string;
        snapshot: Buffer | null;
      }>;
      if (rows.length === 0) break;
      const last = rows[rows.length - 1]!;
      cursor = { doc_name: last.doc_name, id: last.id };
      for (const row of rows) {
        if (!row.snapshot || row.snapshot.byteLength === 0 || isBinaryEnvelope(row.snapshot))
          continue;
        const ctx = {
          docName: row.doc_name,
          kind: 'version',
          field: 'snapshot',
          versionId: row.id,
        } as const;
        const plain = await codec.decodeBinary(new Uint8Array(row.snapshot), ctx);
        result.versions++;
        if (options.dryRun) continue;
        const encoded = await codec.encodeBinary(plain, ctx);
        await knex
          .from(this.t('collab_versions'))
          .where('doc_name', row.doc_name)
          .where('id', row.id)
          .where('snapshot', row.snapshot)
          .update({ snapshot: Buffer.from(encoded) });
      }
      report();
    }

    // Comments, keyset-paged by id.
    let afterComment: string | undefined;
    for (;;) {
      let query = knex
        .from(this.t('collab_comments'))
        .select('*')
        .orderBy('id', 'asc')
        .limit(batchSize);
      if (afterComment !== undefined) query = query.where('id', '>', afterComment);
      const rows = (await query) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      afterComment = rows[rows.length - 1]!.id as string;
      for (const row of rows) {
        const body = row.body as string;
        if (isTextEnvelope(body) && isEncodedAnchor(row.anchor)) continue;
        const plain = await codec.decodeComment(this.rowToComment(row));
        result.comments++;
        if (options.dryRun) continue;
        const encoded = await codec.encodeComment(plain);
        await knex
          .from(this.t('collab_comments'))
          .where('id', row.id as string)
          .where('body', body)
          .update({ body: encoded.body, anchor: encoded.anchor });
      }
      report();
    }

    return result;
  }
}

/** `meta` as stored: a jsonb object, or its JSON text on drivers that return strings. */
function parseMeta(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Factory para config — o `LucidStorage` agora resolve o fachada do Lucid
 * LAZY (import dinâmico no primeiro `ensure()`), então o config pode chamá-lo
 * sem se preocupar com a ordem de boot dos providers.
 *
 * @example
 * // config/collaboration.ts
 * storage: lucidStorage({ connection: 'entretextos', schema: 'collab' })
 */
export function lucidStorage(options: LucidStorageOptions = {}): LucidStorage {
  return new LucidStorage(undefined, options);
}

/**
 * The `LucidStorage` behind `storage`, also when it is wrapped by
 * `withCodec`; `undefined` for any other storage.
 */
export function lucidStorageOf(storage: unknown): LucidStorage | undefined {
  let current = storage;
  while (current instanceof CodecStorage) current = current.inner;
  return current instanceof LucidStorage ? current : undefined;
}
