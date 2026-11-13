import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

/**
 * The `collaboration:<noun>:<verb>` commands through the REAL Ace kernel, running the
 * COMPILED commands (commands.json metadata, flag parsing, container lookup), against a
 * manager on the real in-memory storage.
 */
const pkgRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');
const dist = (file: string) => path.join(pkgRoot, 'dist', file);
const commandsBarrel = dist('commands/main.js');

const ACTOR = `cli:${userInfo().username}`;

type Any = any;

let fixture: string;
let CollaborationManager: Any;
let InMemoryCollaborationStorage: Any;

beforeAll(async () => {
  fixture = path.join(tmpdir(), `collab-cli-fixture-${Date.now()}`);
  mkdirSync(path.join(fixture, 'app'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ type: 'module', name: 'collab-fixture', version: '0.0.0' }),
  );
  ({ CollaborationManager } = await import(dist('src/collaboration_manager.js')));
  ({ InMemoryCollaborationStorage } = await import(dist('src/storage/in_memory_storage.js')));
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const tty = process.stdin.isTTY;
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
});

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

async function kernelFor(manager: unknown) {
  const { IgnitorFactory, AceFactory } = await import('@adonisjs/core/factories');
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .merge({ rcFileContents: { commands: [commandsBarrel] } })
    .create(new URL(`file://${fixture}/`), {
      importer: async (specifier: string) => import(specifier),
    });
  const kernel = await new AceFactory().make(ignitor);
  kernel.addLoader(async () => import(commandsBarrel));
  kernel.app.container.singleton(CollaborationManager, () => manager);
  kernel.ui.switchMode('raw');
  return kernel;
}

/** Runs one command; returns its exit code and everything it printed. */
async function run(
  manager: unknown,
  argv: string[],
  before?: (command: Any) => void,
): Promise<{ exitCode: number; out: string; json: () => Any }> {
  const kernel = await kernelFor(manager);
  await kernel.boot();
  const [name, ...rest] = argv;
  const Command = await kernel.find(name as string);
  const command: Any = await kernel.create(Command, rest);
  before?.(command);
  await command.exec();
  const out = command.ui.logger
    .getLogs()
    .map((l: { message: string }) => l.message)
    .join('\n');
  return { exitCode: command.exitCode ?? 0, out, json: () => JSON.parse(out) };
}

function yjsState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function fixtureManager(options: { presence?: string[]; documents?: object } = {}) {
  const storage = new InMemoryCollaborationStorage();
  const store = {
    members: options.presence ?? [],
    async join() {},
    async leave() {},
    async list() {
      return this.members.map((userId: string) => ({ userId }));
    },
    async close() {},
  };
  const manager = new CollaborationManager(
    { storage, ...(options.documents ? { documents: options.documents } : {}) },
    options.presence ? store : undefined,
  );
  return { manager, storage };
}

async function seedComments(manager: Any, docName: string, count: number) {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const c = await manager.comments.create(docName, {
      space: i % 2 ? 'text' : 'canvas',
      anchor: { kind: 'none' },
      body: `comment ${i}`,
      userId: 'u1',
    });
    ids.push(c.id);
  }
  return ids;
}

// Each test boots a real kernel; the first cold import can pass 5 s on a busy runner.
describe('collaboration CLI', { timeout: 30_000 }, () => {
  it('registers every new command under collaboration:<noun>:<verb>', async () => {
    const loader = await import(commandsBarrel);
    const names = (await loader.getMetaData()).map((c: { commandName: string }) => c.commandName);
    expect(names).toEqual(
      expect.arrayContaining([
        'collaboration:documents:list',
        'collaboration:documents:show',
        'collaboration:versions:list',
        'collaboration:versions:create',
        'collaboration:versions:restore',
        'collaboration:comments:list',
        'collaboration:comments:resolve',
        'collaboration:comments:delete',
        'collaboration:prune',
        'collaboration:compact',
      ]),
    );
  });

  describe('documents', () => {
    it('lists the declared patterns', async () => {
      const { manager } = fixtureManager({
        documents: {
          'researches/:id/writing': { engine: 'yjs', authorize: async () => ({}) },
          'boards/:boardId': { engine: 'automerge' },
        },
      });
      const { exitCode, json } = await run(manager, ['collaboration:documents:list', '--json']);
      expect(exitCode).toBe(0);
      expect(json()).toEqual({
        data: [
          {
            pattern: 'boards/:boardId',
            params: ['boardId'],
            engine: 'automerge',
            authorize: false,
            load: false,
          },
          {
            pattern: 'researches/:id/writing',
            params: ['id'],
            engine: 'yjs',
            authorize: true,
            load: false,
          },
        ],
      });
    });

    it('says so when nothing is declared', async () => {
      const { manager } = fixtureManager();
      const { exitCode, out } = await run(manager, ['collaboration:documents:list']);
      expect(exitCode).toBe(0);
      expect(out).toContain('No documents declared');
    });

    it('shows one document without opening it', async () => {
      const { manager, storage } = fixtureManager({
        documents: { 'researches/:id/writing': {} },
      });
      const state = yjsState('hello');
      await storage.saveDocument('researches/42/writing', state);
      await manager.createVersion({ docName: 'researches/42/writing', createdBy: null });
      await seedComments(manager, 'researches/42/writing', 3);
      const { exitCode, json } = await run(manager, [
        'collaboration:documents:show',
        '--doc=researches/42/writing',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      expect(json()).toEqual({
        docName: 'researches/42/writing',
        pattern: 'researches/:id/writing',
        params: { id: '42' },
        engine: 'yjs',
        storage: 'configured',
        storedBytes: state.byteLength,
        versions: 1,
        comments: 3,
        presence: 0,
        liveHere: false,
      });
    });

    it('fails without --doc', async () => {
      const { manager } = fixtureManager();
      const { exitCode, out } = await run(manager, ['collaboration:documents:show']);
      expect(exitCode).toBe(1);
      expect(out).toContain('--doc is required');
    });
  });

  describe('versions', () => {
    it('creates a version as cli:<os user>', async () => {
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      const { exitCode, json } = await run(manager, [
        'collaboration:versions:create',
        '--doc=docs/a',
        '--label=before import',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      expect(json()).toMatchObject({ seq: 1, label: 'before import', createdBy: ACTOR });
    });

    it('lists versions in the { data, meta } shape with paging and order', async () => {
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      for (let i = 0; i < 3; i++) {
        await manager.createVersion({ docName: 'docs/a', createdBy: null, label: `v${i + 1}` });
      }
      const { exitCode, json } = await run(manager, [
        'collaboration:versions:list',
        '--doc=docs/a',
        '--size=2',
        '--order=desc',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      const page = json();
      expect(page.data.map((v: { seq: number }) => v.seq)).toEqual([3, 2]);
      expect(page.meta).toEqual({
        total: 3,
        perPage: 2,
        currentPage: 1,
        lastPage: 2,
        firstPage: 1,
      });
    });

    it('prints a table by default', async () => {
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      await manager.createVersion({ docName: 'docs/a', createdBy: null, label: 'first' });
      const { exitCode, out } = await run(manager, ['collaboration:versions:list', '--doc=docs/a']);
      expect(exitCode).toBe(0);
      expect(out).toContain('first');
      expect(out).toContain('page 1 of 1 (1 total)');
    });

    it('rejects a bad --order', async () => {
      const { manager } = fixtureManager();
      const { exitCode, out } = await run(manager, [
        'collaboration:versions:list',
        '--doc=docs/a',
        '--order=sideways',
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain('--order must be asc or desc');
    });

    it('restores a version with --force, keeping the current state as a version', async () => {
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      const v1 = await manager.createVersion({ docName: 'docs/a', createdBy: null });
      const { exitCode } = await run(manager, [
        'collaboration:versions:restore',
        v1.id,
        '--doc=docs/a',
        '--force',
      ]);
      expect(exitCode).toBe(0);
      const versions = await storage.listVersions('docs/a');
      expect(versions).toHaveLength(2);
      expect(versions[1].createdBy).toBe(ACTOR);
    });

    it('refuses to restore without a terminal and without --force', async () => {
      setTTY(false);
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      const v1 = await manager.createVersion({ docName: 'docs/a', createdBy: null });
      const { exitCode, out } = await run(manager, [
        'collaboration:versions:restore',
        v1.id,
        '--doc=docs/a',
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain('--force');
      expect(await storage.listVersions('docs/a')).toHaveLength(1);
    });

    it('asks in a terminal and does nothing when the answer is no', async () => {
      setTTY(true);
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      const v1 = await manager.createVersion({ docName: 'docs/a', createdBy: null });
      const { exitCode } = await run(
        manager,
        ['collaboration:versions:restore', v1.id, '--doc=docs/a'],
        (command) =>
          command.prompt
            .trap(`Restore 'docs/a' to version ${v1.id}? The current state is kept as a version.`)
            .reject(),
      );
      expect(exitCode).toBe(1);
      expect(await storage.listVersions('docs/a')).toHaveLength(1);
    });

    it('refuses to restore a document with people in presence, even with --force', async () => {
      const { manager, storage } = fixtureManager({ presence: ['ana'] });
      await storage.saveDocument('docs/a', yjsState('one'));
      const v1 = await manager.createVersion({ docName: 'docs/a', createdBy: null });
      const { exitCode, out } = await run(manager, [
        'collaboration:versions:restore',
        v1.id,
        '--doc=docs/a',
        '--force',
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain('people connected');
      expect(await storage.listVersions('docs/a')).toHaveLength(1);
    });

    it('fails on an unknown version id', async () => {
      const { manager, storage } = fixtureManager();
      await storage.saveDocument('docs/a', yjsState('one'));
      const { exitCode } = await run(manager, [
        'collaboration:versions:restore',
        'nope',
        '--doc=docs/a',
        '--force',
      ]);
      expect(exitCode).toBe(1);
    });
  });

  describe('comments', () => {
    it('lists comments filtered by space, as { data, meta }', async () => {
      const { manager } = fixtureManager();
      await seedComments(manager, 'docs/a', 5);
      const { exitCode, json } = await run(manager, [
        'collaboration:comments:list',
        '--doc=docs/a',
        '--space=text',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      const page = json();
      expect(page.data.map((c: { body: string }) => c.body)).toEqual([
        'comment 1',
        'comment 3',
        'comment 5',
      ]);
      expect(page.meta.total).toBe(3);
    });

    it('resolves and reopens a comment', async () => {
      const { manager } = fixtureManager();
      const [id] = await seedComments(manager, 'docs/a', 1);
      const resolved = await run(manager, [
        'collaboration:comments:resolve',
        id as string,
        '--doc=docs/a',
        '--json',
      ]);
      expect(resolved.exitCode).toBe(0);
      expect(resolved.json().resolvedAt).not.toBeNull();
      const reopened = await run(manager, [
        'collaboration:comments:resolve',
        id as string,
        '--doc=docs/a',
        '--reopen',
        '--json',
      ]);
      expect(reopened.json().resolvedAt).toBeNull();
    });

    it('fails on an unknown comment', async () => {
      const { manager } = fixtureManager();
      const { exitCode, out } = await run(manager, [
        'collaboration:comments:resolve',
        'missing',
        '--doc=docs/a',
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain('No comment missing');
    });

    it('deletes a comment with --force', async () => {
      const { manager } = fixtureManager();
      const [id] = await seedComments(manager, 'docs/a', 2);
      const { exitCode } = await run(manager, [
        'collaboration:comments:delete',
        id as string,
        '--doc=docs/a',
        '--force',
      ]);
      expect(exitCode).toBe(0);
      expect(await manager.comments.count('docs/a')).toBe(1);
    });

    it('refuses to delete without a terminal and without --force', async () => {
      setTTY(false);
      const { manager } = fixtureManager();
      const [id] = await seedComments(manager, 'docs/a', 1);
      const { exitCode } = await run(manager, [
        'collaboration:comments:delete',
        id as string,
        '--doc=docs/a',
      ]);
      expect(exitCode).toBe(1);
      expect(await manager.comments.count('docs/a')).toBe(1);
    });
  });
});
