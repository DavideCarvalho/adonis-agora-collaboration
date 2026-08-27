import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { setApp } from '@adonisjs/core/services/app';
import { Database } from '@adonisjs/lucid/database';
import type { BaseSchema } from '@adonisjs/lucid/schema';

/** The tables the package publishes, in dependency-free creation order. */
const TABLES = ['collab_documents', 'collab_versions', 'collab_comments'] as const;

const stubPath = (table: string) =>
  fileURLToPath(new URL(`../../stubs/collaboration/migrations/${table}.stub`, import.meta.url));

const generatedPath = (table: string) =>
  fileURLToPath(new URL(`./__generated__/${table}.ts`, import.meta.url));

/**
 * Materialize a PUBLISHED migration stub as an importable module.
 *
 * The point of the whole integration suite is that it runs against the schema real apps
 * get — the one `node ace collaboration:init` copies. Re-declaring the tables in the test
 * would make the suite green while the stub drifted, which is the exact failure this is
 * here to catch. So the stub is the source: strip its `{{{ exports(...) }}}` codegen
 * header, fill the one template variable the command fills, and import what is left.
 */
async function loadMigration(table: string): Promise<typeof BaseSchema> {
  const stub = stubPath(table);
  const raw = await readFile(stub, 'utf-8');
  const header = raw.indexOf('}}}');
  if (!raw.startsWith('{{{') || header === -1) {
    throw new Error(`Expected a stub header in ${stub}. Did the stub format change?`);
  }

  const source = raw
    .slice(header + 3)
    .trimStart()
    .replaceAll('{{ migration.tableName }}', table);
  if (source.includes('{{')) {
    throw new Error(
      `${stub} has a template variable this harness does not fill — the migration it runs would not be the one apps get.`,
    );
  }

  const generated = generatedPath(table);
  await mkdir(dirname(generated), { recursive: true });
  await writeFile(generated, source, 'utf-8');
  const mod = (await import(`${generated}?t=${Date.now()}`)) as { default: typeof BaseSchema };
  return mod.default;
}

export interface IntegrationDatabase {
  db: Database;
  teardown(): Promise<void>;
}

/**
 * A Lucid `Database` bound to the throwaway Postgres from `global_setup`, with the
 * collaboration tables created by the real migrations.
 *
 * Each caller gets its own Postgres SCHEMA (`searchPath`), so spec files running in
 * parallel forks cannot see each other's rows — "prune everything but the two most recent
 * versions of every document" is only meaningful when the table holds nothing but this
 * test's documents.
 */
export async function createIntegrationDatabase(schemaName: string): Promise<IntegrationDatabase> {
  const url = process.env.COLLAB_TEST_PG_URL;
  if (!url) {
    throw new Error(
      'COLLAB_TEST_PG_URL is unset — run the integration suite through vitest.integration.config.ts so the container starts.',
    );
  }

  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  // `src/storage/lucid_storage.ts` imports the Lucid db facade at module load, and the
  // facade reads the app service. Priming it here lets a spec import the REAL storage
  // (dynamically, after this call) instead of a copy of it.
  setApp(app);

  const emitter = new Emitter(app);
  const logger = new LoggerFactory().create();

  const db = new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'pg',
          connection: url,
          searchPath: [schemaName],
          pool: { min: 0, max: 4 },
        },
      },
    },
    logger,
    emitter,
  );

  await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  for (const table of TABLES) {
    const Migration = await loadMigration(table);
    const migration = new Migration(db.connection(), stubPath(table), false);
    await migration.execUp();
  }

  return {
    db,
    async teardown() {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await db.manager.closeAll();
    },
  };
}
