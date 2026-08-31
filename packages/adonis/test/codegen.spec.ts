import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');

describe('collaboration:init', async () => {
  const { default: CollaborationInit } = await import('../commands/collaboration_init.js');

  it('registers the collaboration:init command with startApp', () => {
    expect(CollaborationInit.commandName).toBe('collaboration:init');
    expect(CollaborationInit.description).toContain('Scaffold');
    expect(CollaborationInit.options.startApp).toBe(true);
  });

  it('declares the --engine flag with decorator metadata', () => {
    const engineFlag = CollaborationInit.flags?.find(
      (flag: { flagName: string }) => flag.flagName === 'engine',
    );
    expect(engineFlag?.type).toBe('string');
    expect(engineFlag?.description).toBeTruthy();
  });
});

describe('make:collab-document', async () => {
  const { default: MakeCollabDocument } = await import('../commands/make_collab_document.js');

  it('registers the command with a required name argument', () => {
    expect(MakeCollabDocument.commandName).toBe('make:collab-document');
    const nameArg = MakeCollabDocument.args?.[0];
    expect(nameArg?.argumentName ?? nameArg?.name).toBe('name');
    expect(nameArg?.required).toBe(true);
  });

  it('declares the --anchors and --spaces flags', () => {
    const flagNames = MakeCollabDocument.flags?.map((flag: { flagName: string }) => flag.flagName);
    expect(flagNames).toContain('anchors');
    expect(flagNames).toContain('spaces');
  });
});

describe('stubs de codegen', () => {
  it('every .stub declares its destination via exports({to})', async () => {
    const stubDirs = [
      'stubs/collaboration',
      'stubs/collaboration/migrations',
      'stubs/partykit/worker',
    ];
    for (const dir of stubDirs) {
      const entries = await readdir(path.join(pkgRoot, dir));
      for (const file of entries.filter((entry) => entry.endsWith('.stub'))) {
        const content = await readFile(path.join(pkgRoot, dir, file), 'utf-8');
        expect(content, `${dir}/${file} missing exports block`).toMatch(
          /\{\{\{\s*exports\(\s*\{\s*to:/,
        );
      }
    }
  });

  it('partykit worker stub verifies tokens and exposes onRequest/onBeforeConnect', async () => {
    const worker = await readFile(
      path.join(pkgRoot, 'stubs/partykit/worker/party.ts.stub'),
      'utf-8',
    );
    expect(worker).toContain('onBeforeConnect');
    expect(worker).toContain('onRequest');
    expect(worker).toContain('verifyToken');
    expect(worker).toContain("from 'y-partykit'");
  });

  it('migrations generate the three base tables', async () => {
    const migrationsDir = path.join(pkgRoot, 'stubs/collaboration/migrations');
    const files = await readdir(migrationsDir);
    expect(files.sort()).toEqual([
      'collab_comments.stub',
      'collab_documents.stub',
      'collab_versions.stub',
    ]);
  });

  it('document_types.stub interpolates className, anchors and spaces', async () => {
    const types = await readFile(
      path.join(pkgRoot, 'stubs/collaboration/document_types.stub'),
      'utf-8',
    );
    expect(types).toContain('{{ document.className }}');
    expect(types).toContain('{{#each document.anchorKinds}}');
    expect(types).toContain('{{#each document.spaceList}}');
  });
});

describe('commands.json build script', () => {
  it('build script exists and emits version 1 format compatible with the barrel', async () => {
    const script = await readFile(path.join(pkgRoot, 'scripts/build-commands.mjs'), 'utf-8');
    expect(script).toContain('version: 1');
    expect(script).toContain('filePath');

    const main = await readFile(path.join(pkgRoot, 'commands/main.ts'), 'utf-8');
    // Barrel reads ./commands.json relative to its own file (lucid pattern).
    expect(main).toContain('./commands.json');
    expect(main).toContain('getMetaData');
    expect(main).toContain('getCommand');
  });
});
