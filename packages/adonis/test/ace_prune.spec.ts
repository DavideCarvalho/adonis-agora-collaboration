import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `node ace collaboration:prune` through the REAL Ace kernel, running the COMPILED
 * command — the same path a user's terminal takes: commands.json metadata, decorator flag
 * parsing (`--keep`, `--doc`, `--dry-run`) and the container lookup of the manager.
 *
 * The manager is bound from `dist` so the container key is the very class the compiled
 * command resolves; its storage is the real in-memory implementation, so the assertions
 * are about rows that did or did not disappear, not about a spy being called.
 */
const pkgRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');
const commandsBarrel = path.join(pkgRoot, 'dist', 'commands', 'main.js');
const managerModule = path.join(pkgRoot, 'dist', 'src', 'collaboration_manager.js');
const storageModule = path.join(pkgRoot, 'dist', 'src', 'storage', 'in_memory_storage.js');

interface Storage {
  saveVersion(docName: string, version: unknown, snapshot: Uint8Array): Promise<void>;
  listVersions(docName: string): Promise<Array<{ seq: number }>>;
}

async function seed(storage: Storage, docName: string, count: number): Promise<void> {
  for (let seq = 1; seq <= count; seq++) {
    await storage.saveVersion(
      docName,
      {
        id: `v${seq}`,
        seq,
        createdAt: new Date(2026, 0, seq).toISOString(),
        createdBy: null,
        label: null,
      },
      new Uint8Array([seq]),
    );
  }
}

async function buildKernel(fixture: string, storage: Storage) {
  const { IgnitorFactory, AceFactory } = await import('@adonisjs/core/factories');
  const { CollaborationManager } = await import(managerModule);

  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .merge({ rcFileContents: { commands: [commandsBarrel] } })
    .create(new URL(`file://${fixture}/`), {
      importer: async (specifier: string) => import(specifier),
    });

  const kernel = await new AceFactory().make(ignitor);
  kernel.addLoader(async () => import(commandsBarrel));
  // The binding goes on the kernel's own app container — the one
  // `this.app.container.make()` reads from inside the command.
  kernel.app.container.singleton(CollaborationManager, () => new CollaborationManager({ storage }));
  // Surface the real command error instead of the silent CLI renderer.
  (kernel as unknown as { errorHandler: { render(error: unknown): Promise<void> } }).errorHandler =
    {
      render: async (error) => {
        throw error;
      },
    };
  return kernel;
}

describe('ace integration: collaboration:prune', () => {
  let fixture: string;
  let makeStorage: () => Storage;

  beforeAll(async () => {
    fixture = path.join(tmpdir(), `collab-prune-fixture-${Date.now()}`);
    mkdirSync(path.join(fixture, 'app'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ type: 'module', name: 'collab-fixture', version: '0.0.0' }),
    );

    const { InMemoryCollaborationStorage } = await import(storageModule);
    makeStorage = () => new InMemoryCollaborationStorage() as Storage;
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('keeps --keep versions per document', async () => {
    const storage = makeStorage();
    await seed(storage, 'docs/busy', 6);
    await seed(storage, 'docs/quiet', 3);
    const kernel = await buildKernel(fixture, storage);

    await kernel.handle(['collaboration:prune', '--keep=2']);

    expect(kernel.exitCode ?? 0).toBe(0);
    expect((await storage.listVersions('docs/busy')).map((v) => v.seq)).toEqual([5, 6]);
    expect((await storage.listVersions('docs/quiet')).map((v) => v.seq)).toEqual([2, 3]);
  });

  it('--dry-run deletes nothing', async () => {
    const storage = makeStorage();
    await seed(storage, 'docs/busy', 6);
    const kernel = await buildKernel(fixture, storage);

    await kernel.handle(['collaboration:prune', '--keep=2', '--dry-run']);

    expect(kernel.exitCode ?? 0).toBe(0);
    expect((await storage.listVersions('docs/busy')).map((v) => v.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('--doc narrows the prune to one document', async () => {
    const storage = makeStorage();
    await seed(storage, 'docs/busy', 4);
    await seed(storage, 'docs/quiet', 4);
    const kernel = await buildKernel(fixture, storage);

    await kernel.handle(['collaboration:prune', '--keep=1', '--doc=docs/busy']);

    expect(kernel.exitCode ?? 0).toBe(0);
    expect((await storage.listVersions('docs/busy')).map((v) => v.seq)).toEqual([4]);
    expect((await storage.listVersions('docs/quiet')).map((v) => v.seq)).toEqual([1, 2, 3, 4]);
  });

  it('defaults to keeping 20 versions per document', async () => {
    const storage = makeStorage();
    await seed(storage, 'docs/busy', 25);
    const kernel = await buildKernel(fixture, storage);

    await kernel.handle(['collaboration:prune']);

    expect(kernel.exitCode ?? 0).toBe(0);
    expect(await storage.listVersions('docs/busy')).toHaveLength(20);
  });

  it('fails with a non-zero exit code on an invalid --keep, without deleting', async () => {
    const storage = makeStorage();
    await seed(storage, 'docs/busy', 4);
    const kernel = await buildKernel(fixture, storage);

    await kernel.handle(['collaboration:prune', '--keep=-3']);

    expect(kernel.exitCode).toBe(1);
    expect(await storage.listVersions('docs/busy')).toHaveLength(4);
  });
});
