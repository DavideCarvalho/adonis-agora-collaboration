import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const packageRoot = join(here, '..');

describe('the client does not ask for what the routes discard', () => {
  it('rejects a userId on createVersion, createComment and useComments().create', () => {
    const configPath = join(packageRoot, 'tsconfig.json');
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    } as unknown as ts.ParseConfigFileHost);

    const fixture = join(packageRoot, 'test/__type_fixture__.ts');
    const program = ts.createProgram([fixture], {
      ...parsed!.options,
      noEmit: true,
      incremental: false,
      tsBuildInfoFile: undefined,
    });

    const reported = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName.endsWith('__type_fixture__.ts'))
      .map(
        (diagnostic) =>
          `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );

    expect(reported).toEqual([]);
  }, 60_000);
});
