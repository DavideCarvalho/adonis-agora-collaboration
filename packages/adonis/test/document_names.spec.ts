import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const packageRoot = join(here, '..');

describe('declared document names are type-checkable', () => {
  it('accepts declared names and rejects undeclared ones', () => {
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
