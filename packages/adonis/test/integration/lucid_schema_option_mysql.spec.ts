import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { setApp } from '@adonisjs/core/services/app';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LucidConnectionLike } from '../../src/storage/lucid_storage.js';
import { loadMigration, stubPath, TABLES } from './harness.js';
import { exercise } from './storage_exercise.js';

/**
 * `lucidStorage({ schema })` on MySQL 8, where the schema is a database: the
 * connection's own database (`app`) stays empty, every statement names
 * `` `schema`.`table` ``, and the published migrations rendered for the schema
 * run there (they skip `createSchemaIfNotExists`, which is Postgres-only).
 */
const TABLE = /collab_(?:documents|versions|comments)(?![\w])/g;
const DEFAULT_DATABASE = 'app';

let app: Awaited<ReturnType<typeof makeApp>>;

async function makeApp() {
  const instance = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await instance.init();
  setApp(instance);
  return instance;
}

function makeDatabase(credentials?: { user: string; password: string }): Database {
  const url = new URL(process.env.COLLAB_TEST_MYSQL_URL as string);
  return new Database(
    {
      connection: 'm',
      connections: {
        m: {
          client: 'mysql2',
          connection: {
            host: url.hostname,
            port: Number(url.port),
            user: credentials?.user ?? decodeURIComponent(url.username),
            password: credentials?.password ?? decodeURIComponent(url.password),
            database: url.pathname.slice(1),
          },
          pool: { min: 0, max: 4 },
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
}

function recordQueries(db: Database): string[] {
  const log: string[] = [];
  (
    db.connection() as unknown as {
      getWriteClient(): { on(event: 'query', cb: (q: { sql: string }) => void): void };
    }
  )
    .getWriteClient()
    .on('query', (query) => log.push(query.sql));
  return log;
}

function unqualified(sql: string, schema: string): string[] {
  const bad: string[] = [];
  for (const match of sql.matchAll(TABLE)) {
    if (!sql.slice(0, match.index).endsWith(`\`${schema}\`.\``)) bad.push(match[0]);
  }
  return bad;
}

async function tablesIn(db: Database, schema: string): Promise<string[]> {
  const [rows] = (await db.rawQuery(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'collab_%' ORDER BY table_name",
    [schema],
  )) as [{ name: string }[]];
  return rows.map((r) => r.name);
}

describe('LucidStorage with `schema` (MySQL, schema = database)', () => {
  let db: Database;
  let schema: string;

  beforeAll(async () => {
    if (!process.env.COLLAB_TEST_MYSQL_URL) {
      throw new Error('COLLAB_TEST_MYSQL_URL is unset — run through vitest.integration.config.ts');
    }
    app = await makeApp();
  });

  afterEach(async () => {
    await db.rawQuery(`DROP DATABASE IF EXISTS \`${schema}\``);
    await db.manager.closeAll();
  });

  it('creates the database and tables itself, every statement qualified', async () => {
    db = makeDatabase();
    schema = 'collab_my_selfmade';
    await db.rawQuery(`DROP DATABASE IF EXISTS \`${schema}\``);
    const log = recordQueries(db);
    const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
    const storage = new LucidStorage(db as unknown as LucidConnectionLike, { schema });

    await exercise(storage);

    expect(log.some((sql) => sql.startsWith(`CREATE DATABASE IF NOT EXISTS \`${schema}\``))).toBe(
      true,
    );
    expect(await tablesIn(db, schema)).toEqual([
      'collab_comments',
      'collab_documents',
      'collab_versions',
    ]);
    expect(await tablesIn(db, DEFAULT_DATABASE)).toEqual([]);
    expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
  });

  it('runs on the published migrations rendered for the schema', async () => {
    db = makeDatabase();
    schema = 'collab_my_migrated';
    await db.rawQuery(`DROP DATABASE IF EXISTS \`${schema}\``);
    // On MySQL the app creates the database; the migrations create the tables in it.
    await db.rawQuery(`CREATE DATABASE \`${schema}\``);
    for (const table of TABLES) {
      const Migration = await loadMigration(table, schema);
      await new Migration(db.connection(), stubPath(table), false).execUp();
    }
    expect(await tablesIn(db, schema)).toHaveLength(3);
    expect(await tablesIn(db, DEFAULT_DATABASE)).toEqual([]);

    const log = recordQueries(db);
    const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
    await exercise(new LucidStorage(db as unknown as LucidConnectionLike, { schema }));
    expect(log.some((sql) => /create table/i.test(sql))).toBe(false);
    expect(log.flatMap((sql) => unqualified(sql, schema))).toEqual([]);
  });

  it('a login that cannot create the database gets a message naming it and the grant', async () => {
    db = makeDatabase();
    schema = 'collab_my_denied';
    await db.rawQuery(`DROP DATABASE IF EXISTS \`${schema}\``);
    const user = `collab_ro_${process.pid}`;
    await db.rawQuery(`DROP USER IF EXISTS '${user}'@'%'`);
    await db.rawQuery(`CREATE USER '${user}'@'%' IDENTIFIED BY 'pw'`);
    await db.rawQuery(`GRANT ALL ON \`${DEFAULT_DATABASE}\`.* TO '${user}'@'%'`);
    const limited = makeDatabase({ user, password: 'pw' });
    try {
      const { LucidStorage } = await import('../../src/storage/lucid_storage.js');
      const storage = new LucidStorage(limited as unknown as LucidConnectionLike, { schema });
      await expect(storage.loadDocument('x')).rejects.toThrow(
        new RegExp(`could not create the database "${schema}".*GRANT CREATE ON \\*\\.\\*`),
      );
    } finally {
      await limited.manager.closeAll();
      await db.rawQuery(`DROP USER '${user}'@'%'`);
    }
  });
});
