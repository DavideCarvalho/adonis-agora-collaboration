import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { LucidConnectionLike } from '../../src/storage/lucid_storage.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';
import { exercise } from './storage_exercise.js';

/**
 * `lucidStorage({ schema })` against a real Postgres whose connection keeps its
 * default search_path (`public`): every statement names the schema, nothing
 * lands in `public`, and the storage creates the schema itself when the app did
 * not run the migrations.
 */
const TABLE = /collab_(?:documents|versions|comments)(?![\w])/g;

/** Every SQL statement the connection sends from now on. */
function recordQueries(integration: IntegrationDatabase): string[] {
  const log: string[] = [];
  const knex = (
    integration.db.connection() as unknown as {
      getWriteClient(): { on(event: 'query', cb: (q: { sql: string }) => void): void };
    }
  ).getWriteClient();
  knex.on('query', (query) => log.push(query.sql));
  return log;
}

function unqualified(sql: string, schema: string): string[] {
  const bad: string[] = [];
  for (const match of sql.matchAll(TABLE)) {
    if (!sql.slice(0, match.index).endsWith(`"${schema}"."`)) bad.push(match[0]);
  }
  return bad;
}

async function tablesIn(integration: IntegrationDatabase, schema: string): Promise<string[]> {
  const result = await integration.db.rawQuery(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'collab_%' ORDER BY table_name",
    [schema],
  );
  return (result.rows as { table_name: string }[]).map((r) => r.table_name);
}

describe('LucidStorage with `schema` (Postgres, default search_path)', () => {
  let integration: IntegrationDatabase | undefined;

  afterEach(async () => {
    await integration?.teardown();
    integration = undefined;
  });

  it('runs on the published migrations rendered for the schema, every statement qualified', async () => {
    const schema = 'collab_qualified';
    integration = await createIntegrationDatabase(schema, { mode: 'qualified' });
    const searchPath = await integration.db.rawQuery('SHOW search_path');
    expect(searchPath.rows[0].search_path).toBe('"$user", public');
    expect(await tablesIn(integration, schema)).toEqual([
      'collab_comments',
      'collab_documents',
      'collab_versions',
    ]);
    expect(await tablesIn(integration, 'public')).toEqual([]);

    const log = recordQueries(integration);
    const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
    const storage = new LucidStorage(integration.db as unknown as LucidConnectionLike, {
      schema,
    });
    await exercise(storage);

    // The tables were there: nothing was created, nothing went to `public`.
    expect(log.some((sql) => /create table/i.test(sql))).toBe(false);
    expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
    expect(log.some((sql) => /search_path/i.test(sql))).toBe(false);
    expect(await tablesIn(integration, 'public')).toEqual([]);
  });

  it('creates the schema and tables itself when the migrations did not run', async () => {
    const schema = 'collab_selfmade';
    integration = await createIntegrationDatabase(schema, { mode: 'none' });
    const log = recordQueries(integration);
    const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
    const db = integration.db as unknown as LucidConnectionLike;

    // Two instances racing the first use, like two processes booting.
    const a = new LucidStorage(db, { schema });
    const b = new LucidStorage(db, { schema });
    await Promise.all([a.loadDocument('x'), b.loadDocument('x')]);
    await exercise(a);

    expect(log.some((sql) => sql.startsWith(`CREATE SCHEMA IF NOT EXISTS "${schema}"`))).toBe(true);
    expect(await tablesIn(integration, schema)).toEqual([
      'collab_comments',
      'collab_documents',
      'collab_versions',
    ]);
    expect(await tablesIn(integration, 'public')).toEqual([]);
    expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
  });

  it('a role that cannot create the schema gets a message naming it and the grant', async () => {
    const schema = 'collab_denied';
    integration = await createIntegrationDatabase(schema, { mode: 'none' });
    const role = `collab_ro_${process.pid}`;
    await integration.db.rawQuery(`DROP ROLE IF EXISTS ${role}`);
    await integration.db.rawQuery(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    // A new role has no CREATE on the database (PUBLIC gets only CONNECT and TEMP).
    const url = new URL(process.env.COLLAB_TEST_PG_URL as string);
    url.username = role;
    url.password = 'pw';
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
    const limited = new Database(
      { connection: 'pg', connections: { pg: { client: 'pg', connection: url.toString() } } },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    try {
      const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
      const storage = new LucidStorage(limited as unknown as LucidConnectionLike, { schema });
      await expect(storage.loadDocument('x')).rejects.toThrow(
        new RegExp(`could not create the schema "${schema}".*GRANT CREATE ON DATABASE`),
      );
    } finally {
      await limited.manager.closeAll();
      await integration.db.rawQuery(`DROP ROLE ${role}`);
    }
  });
});
