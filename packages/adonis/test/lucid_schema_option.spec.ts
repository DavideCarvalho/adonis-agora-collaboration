import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LucidStorage, lucidStorage } from '../src/storage/lucid_storage.js';

const fakeDb = (dialect: string) => ({
  connection: () => ({ dialect: { name: dialect } }),
});

describe('lucidStorage({ schema })', () => {
  it.each([['1abc'], ['has space'], ['a"b'], ['a.b'], [''], ['x'.repeat(64)]])(
    'rejects the schema name %j when the storage is built',
    (schema) => {
      expect(() => lucidStorage({ schema })).toThrow(/invalid schema/);
    },
  );

  it('accepts a plain identifier and keeps it', () => {
    expect(lucidStorage({ connection: 'pg', schema: 'collab' }).schema).toBe('collab');
    expect(lucidStorage().schema).toBeUndefined();
  });

  it('still takes a bare connection name', () => {
    expect(new LucidStorage(undefined, 'pg').schema).toBeUndefined();
  });

  it('fails on SQLite instead of ignoring the schema', async () => {
    const storage = new LucidStorage(fakeDb('better-sqlite3'), { schema: 'collab' });
    await expect(storage.assertSchemaSupported()).rejects.toThrow(/SQLite has no schemas/);
    await expect(storage.loadDocument('x')).rejects.toThrow(/SQLite has no schemas/);
  });

  it('accepts Postgres and does not check without a schema', async () => {
    await expect(
      new LucidStorage(fakeDb('postgres'), { schema: 'collab' }).assertSchemaSupported(),
    ).resolves.toBeUndefined();
    await expect(
      new LucidStorage(fakeDb('better-sqlite3')).assertSchemaSupported(),
    ).resolves.toBeUndefined();
  });

  it('the provider checks the schema at boot', async () => {
    const provider = await readFile(
      fileURLToPath(new URL('../providers/collaboration_provider.ts', import.meta.url)),
      'utf8',
    );
    const boot = provider.slice(
      provider.indexOf('async boot()'),
      provider.indexOf('async ready()'),
    );
    expect(boot).toContain('assertSchemaSupported()');
  });

  it('the published migrations take the schema', async () => {
    for (const table of ['collab_documents', 'collab_versions', 'collab_comments']) {
      const stub = await readFile(
        fileURLToPath(new URL(`../stubs/collaboration/migrations/${table}.stub`, import.meta.url)),
        'utf8',
      );
      expect(stub).toContain("protected schemaName = '{{ migration.schema }}'");
      expect(stub).toContain('this.schema.createSchemaIfNotExists(this.schemaName)');
      expect(stub).toContain('this.schema.withSchema(this.schemaName).createTable(');
      expect(stub).toContain('this.schema.withSchema(this.schemaName).dropTable(');
      // The stub renderer compiles the file into a template literal.
      expect(stub).not.toContain('`');
    }
  });
});
