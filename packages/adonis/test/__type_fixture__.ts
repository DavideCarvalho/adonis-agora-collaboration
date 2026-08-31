/**
 * Compiled by `document_names.spec.ts` through `tsc` (see `tsconfig.fixture.json`) —
 * NOT a test file (vitest only collects `*.spec.ts`), and excluded from the
 * package typecheck along with the rest of `test/`.
 *
 * Every `@ts-expect-error` below is the assertion: if the union widens back to
 * `string`, the suppression becomes unused and tsc reports error 2578.
 */
import type { CollabDocumentNameFor, InferCollabDocumentNames } from '../src/define_config.js';
import { defineConfig } from '../src/define_config.js';
import { defineDocument } from '../src/documents.js';

const config = defineConfig({
  engine: 'yjs',
  documents: {
    'researches/:id/writing': defineDocument<{ id: string }>({ engine: 'yjs' }),
    'whiteboards/:id': defineDocument<{ id: string }>({ engine: 'automerge' }),
  },
});

type Names = InferCollabDocumentNames<typeof config>;

const declared: Names = 'researches/:id/writing';
const alsoDeclared: Names = 'whiteboards/:id';
// @ts-expect-error a document the config never declares is not a declared name
const undeclared: Names = 'invoices/:id';

type Writing = CollabDocumentNameFor<'researches/:id/writing'>;

const resolved: Writing = 'researches/42/writing';
// @ts-expect-error the pattern has to match, not merely be some string
const misspelled: Writing = 'research/42/writing';

export const used = [declared, alsoDeclared, undeclared, resolved, misspelled];
