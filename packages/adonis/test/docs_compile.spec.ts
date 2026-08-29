import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@mdx-js/mdx';
import { describe, expect, it } from 'vitest';
import type { CollaborationEngine } from '../src/types.js';

/**
 * The docs are rendered by the Agora site, in another repo, from `main` — nothing in this
 * repo compiles them. So an unparseable page passes CI, passes review, merges, and takes
 * the documentation site's build down; the first sign is a red deploy on a repo that has
 * not changed. Both failures that caused it were ordinary prose: an inline code span broken
 * across a newline, which makes MDX read the `{ ... }` starting the next line as an
 * expression, and a JSX attribute holding unescaped double quotes.
 */
describe('docs', () => {
  const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));

  const pages = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return pages(path);
        return entry.name.endsWith('.mdx') ? [path] : [];
      }),
    );
    return found.flat();
  };

  it('parses every page as MDX', async () => {
    const found = await pages(docsDir);
    expect(found.length, 'no .mdx pages found — is the path still right?').toBeGreaterThan(20);

    const broken: string[] = [];
    for (const path of found) {
      try {
        await compile(await readFile(path, 'utf-8'), { jsx: true });
      } catch (error) {
        broken.push(`${path.slice(docsDir.length)} — ${(error as Error).message.split('\n')[0]}`);
      }
    }
    expect(broken, `pages that would break the docs site's build:\n${broken.join('\n')}`).toEqual(
      [],
    );
  });

  /**
   * "What works out of the box" is the page a reader decides on, and everything in it is a
   * fact that lives in code. A shipped engine or storage the table forgets is a feature that
   * exists, works, is tested — and that nobody finds.
   */
  it('names every engine and every storage in the out-of-the-box table', async () => {
    const index = await readFile(`${docsDir}index.mdx`, 'utf-8');
    const section = index.split('## What works out of the box')[1]?.split('\n## Where to go')[0];
    expect(section, 'the "What works out of the box" section is gone').toBeDefined();

    // The engine union is the config's own vocabulary; a value missing here cannot be chosen.
    const engines: CollaborationEngine[] = ['yjs', 'automerge', 'partykit', 'partyserver'];
    const types = await readFile(
      fileURLToPath(new URL('../src/types.js', import.meta.url)).replace(/\.js$/, '.ts'),
      'utf-8',
    );
    const declared = types.match(/export type CollaborationEngine = ([^;]+);/)?.[1] ?? '';
    for (const engine of engines) {
      expect(declared, `${engine} is not in the CollaborationEngine union any more`).toContain(
        `'${engine}'`,
      );
      expect(section, `engine "${engine}" ships but the table does not list it`).toContain(engine);
    }

    const exported = await readFile(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf-8',
    );
    const storages = [...exported.matchAll(/export \{ ([^}]*Storage[^}]*) \}/g)]
      .flatMap((match) => match[1].split(','))
      .map((name) => name.trim())
      .filter((name) => name.endsWith('Storage') || name === 'lucidStorage');
    expect(storages.length, 'no storages exported — has index.ts moved?').toBeGreaterThan(2);
    for (const storage of storages) {
      expect(section, `storage "${storage}" is exported but the table does not list it`).toContain(
        storage,
      );
    }
  });
});
