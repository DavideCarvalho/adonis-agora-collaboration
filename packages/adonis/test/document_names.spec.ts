import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `codegen_init.ts` indexes `./app/collaboration/documents` and emits
 * `.adonisjs/collaboration/documents.ts` — but the documented way to declare a
 * document is `defineDocument` inline in `config/collaboration.ts`, so that
 * directory does not exist, the hook early-returns and nothing is generated.
 * There was no bridge at all from `config.documents` to a checkable type, and
 * every call site hand-built doc-name strings.
 *
 * The bridge is `defineConfig` staying generic (a widened return type erased
 * the literal keys) plus `InferCollabDocumentNames`. This test typechecks a
 * fixture that asserts both directions; the negative cases are
 * `@ts-expect-error`, so a widened union fails as an *unused* suppression.
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Runs `tsc` on `tsconfig.fixture.json` (the package tsconfig narrowed to the
 * fixture) and returns the diagnostics reported against the fixture as
 * `TS<code>: <message>`. Shelling out to the binary rather than driving the
 * compiler API keeps this working across TypeScript majors: TS 7 (the native
 * compiler) no longer ships the JS `createProgram` API from `typescript`.
 */
function typecheckFixture(): string[] {
  const typescriptPackage = require.resolve('typescript/package.json');
  const { bin } = JSON.parse(readFileSync(typescriptPackage, 'utf8')) as { bin: { tsc: string } };
  const tsc = join(dirname(typescriptPackage), bin.tsc);
  const result = spawnSync(
    process.execPath,
    [tsc, '-p', join(here, 'tsconfig.fixture.json'), '--pretty', 'false'],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;

  return `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => /^(.*__type_fixture__\.ts)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[2]}: ${match[3]}`);
}

describe('declared document names are type-checkable', () => {
  it('accepts declared names and rejects undeclared ones', () => {
    expect(typecheckFixture()).toEqual([]);
  }, 60_000);
});
