import { existsSync } from 'node:fs';
import { hooks } from '@adonisjs/core/app';
import { documentKeyFromVfsKey, renderDocumentsRegistry } from './codegen/documents_registry.js';

/**
 * Assembler `init` hook (AdonisJS v7 codegen).
 *
 * Registers an IndexGenerator source that scans `app/collaboration/documents`
 * and generates `.adonisjs/collaboration/documents.ts` — the typed registry
 * of collaborative documents (`CollabDocumentName`,
 * `CollabDocumentDefinition`), refreshed by `node ace codegen`, the dev
 * server, test runner and production build.
 *
 * Registered in adonisrc.ts by `node ace configure`:
 *
 * ```
 * hooks: {
 *   init: [() => import('@adonis-agora/collaboration/codegen_init')]
 * }
 * ```
 *
 * **Scope, stated plainly.** This hook only knows about the directory, which
 * only exists once `make:collab-document` created it. Documents declared the
 * other supported way — `defineDocument` inline in `config/collaboration.ts` —
 * are invisible to it, and it early-returns generating nothing. For those,
 * derive the union from the config with `InferCollabDocumentNames<typeof
 * collaborationConfig>`; `defineConfig` is generic so the literal keys
 * survive. See docs/codegen/documents-registry.
 */
// The wrapper's inferred return type references non-portable @poppinss
// internals — annotate explicitly so the declaration emit stays portable.
const initHook = hooks.init(
  (
    _parent: unknown,
    _hooksManager: unknown,
    indexGenerator: {
      add(name: string, config: Record<string, unknown>): unknown;
    },
  ) => {
    const source = './app/collaboration/documents';

    // Directory not created yet: nothing to index. Apps that declare their
    // documents inline in config/collaboration.ts never create it — that is
    // expected, and InferCollabDocumentNames is their route to the same type.
    if (!existsSync(source)) {
      return;
    }

    indexGenerator.add('collabDocuments', {
      source,
      glob: ['**/*.ts'],
      output: './.adonisjs/collaboration/documents.ts',
      as: (
        vfs: { asList(): Record<string, string> },
        buffer: { writeLine(line: string): unknown },
        _config: unknown,
        helpers: { toImportPath(filePath: string): string },
      ) => {
        const files = Object.entries(vfs.asList()).map(([vfsKey, absolutePath]) => ({
          vfsKey,
          importPath: helpers.toImportPath(absolutePath),
        }));

        for (const line of renderDocumentsRegistry(files)) {
          buffer.writeLine(line);
        }
      },
    });
  },
);

// biome-ignore lint/suspicious/noExplicitAny: keeps the export assignable to the rcFile hooks typing without non-portable @poppinss types
export default initHook as (parent: any, hooksManager: any, indexGenerator: any) => void;
