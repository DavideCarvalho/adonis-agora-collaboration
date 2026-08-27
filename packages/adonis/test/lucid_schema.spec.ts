import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `LucidStorage` creates its tables lazily (CREATE TABLE IF NOT EXISTS) and
 * `collaboration:init` publishes migrations that create the same tables. Both
 * definitions have to agree: when they drift, the app that runs the published
 * migrations gets a table the storage cannot query, and every read fails at
 * runtime with a missing-column error.
 */
const TABLES = ['collab_documents', 'collab_versions', 'collab_comments'] as const;

const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Column names from the `t.type('name')` / `table.type('name')` calls in a block. */
function columnsIn(block: string): Set<string> {
  const names = new Set<string>();
  for (const match of block.matchAll(
    /\b(?:t|table)\.(?:string|text|integer|binary|jsonb|uuid|timestamp|boolean)\(\s*'([^']+)'/g,
  )) {
    names.add(match[1]!);
  }
  return names;
}

async function lazyColumns(table: string): Promise<Set<string>> {
  const storage = await source('../src/storage/lucid_storage.ts');
  const start = storage.indexOf(`createTableIfNotExists('${table}'`);
  expect(start, `${table} is not created by LucidStorage`).toBeGreaterThan(-1);
  // The block ends at its own closing line — an inline `{ useTz: true });`
  // would otherwise cut it short halfway through the columns.
  const end = storage.indexOf('\n    });', start);
  return columnsIn(storage.slice(start, end));
}

async function migrationColumns(table: string): Promise<Set<string>> {
  return columnsIn(await source(`../stubs/collaboration/migrations/${table}.stub`));
}

describe('LucidStorage schema ↔ published migrations', () => {
  for (const table of TABLES) {
    it(`${table} declares the same columns in both places`, async () => {
      const [lazy, migration] = await Promise.all([lazyColumns(table), migrationColumns(table)]);
      expect([...migration].sort()).toEqual([...lazy].sort());
    });
  }

  it('keeps a column for the version snapshot, so restore is not a no-op', async () => {
    expect(await lazyColumns('collab_versions')).toContain('snapshot');
    expect(await migrationColumns('collab_versions')).toContain('snapshot');

    const storage = await source('../src/storage/lucid_storage.ts');
    expect(storage).toMatch(/saveVersion\([^)]*snapshot: Uint8Array/);
    expect(storage).toContain('snapshot: Buffer.from(snapshot)');
  });
});
