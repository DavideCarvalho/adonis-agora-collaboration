import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `createVersion` still sent a `userId` in the POST body and
 * `UseCommentsResult['create']` still *required* one, long after the routes
 * started stamping the authenticated caller and dropping whatever the body
 * claimed. Both read as if the value decided something.
 *
 * Dropping a parameter is a type-level change, so the assertion is a type-level
 * one: this typechecks a fixture whose negative cases are `@ts-expect-error`,
 * which fail as *unused* suppressions the moment a signature takes `userId`
 * back.
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

describe('the client does not ask for what the routes discard', () => {
  it('rejects a userId on createVersion, createComment and useComments().create', () => {
    expect(typecheckFixture()).toEqual([]);
  }, 60_000);
});
