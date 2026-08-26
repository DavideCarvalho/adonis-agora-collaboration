import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real ace integration test: boots a minimal AdonisJS app fixture and
 * executes the COMPILED `make:collab-document` command through the actual
 * Ace kernel — proving the commands barrel, commands.json metadata,
 * decorator args/flags parsing and command execution all work end-to-end
 * the way users experience them.
 *
 * Known limitation: the generated-file write goes through
 * `codemods.makeUsingStub`, whose Edge-lite rendering depends on app
 * bootstrap details that this lightweight factory fixture does not fully
 * replicate. File-content correctness is therefore covered by
 * `codegen.spec.ts` (stub structure) + `codegen_hook.spec.ts` (renderer).
 */
const pkgRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');
const commandsBarrel = path.join(pkgRoot, 'dist', 'commands', 'main.js');

async function buildKernel(fixture: string) {
  const { IgnitorFactory } = await import('@adonisjs/core/factories');
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .merge({
      rcFileContents: {
        commands: [commandsBarrel],
      },
    })
    .create(new URL(`file://${fixture}/`), {
      importer: async (specifier: string) => import(specifier),
    });

  const { AceFactory } = await import('@adonisjs/core/factories');
  const kernel = await new AceFactory().make(ignitor);
  // Our barrel exposes getMetaData/getCommand — exactly the Loader contract.
  kernel.addLoader(async () => import(commandsBarrel));
  return kernel;
}

describe('ace integration: make:collab-document', () => {
  let fixture: string;

  beforeAll(() => {
    fixture = path.join(tmpdir(), `collab-ace-fixture-${Date.now()}`);
    mkdirSync(path.join(fixture, 'app'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ type: 'module', name: 'collab-fixture', version: '0.0.0' }),
    );
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('runs the compiled command through the real kernel (exit 0)', async () => {
    const kernel = await buildKernel(fixture);

    // Surface the real command error instead of the silent CLI renderer.
    (
      kernel as unknown as { errorHandler: { render(error: unknown): Promise<void> } }
    ).errorHandler = {
      render: async (error) => {
        throw error;
      },
    };

    await kernel.handle(['make:collab-document', 'researches/writing']);

    expect(kernel.exitCode ?? 0).toBe(0);
  });

  it('rejects invalid --anchors values with a non-zero exit code', async () => {
    const kernel = await buildKernel(fixture);

    await kernel.handle(['make:collab-document', 'blog/post', '--anchors=banana']);

    expect(kernel.exitCode).toBe(1);
  });
});
