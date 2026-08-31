/**
 * Compiled by `document_names.spec.ts` through `tsc` (see `tsconfig.fixture.json`) —
 * NOT a test file (vitest only collects `*.spec.ts`), and excluded from the
 * package typecheck along with the rest of `test/`.
 *
 * Every `@ts-expect-error` below is the assertion: if the union widens back to
 * `string`, or `params` widens back to `Record<string, string>`, the
 * suppression becomes unused and tsc reports error 2578.
 */
import type {
  CollabDocumentNameFor,
  CollaborationAppConfig,
  InferCollabDocumentNames,
} from '../src/define_config.js';
import { defineConfig } from '../src/define_config.js';
import type { DocumentParams } from '../src/documents.js';
import { defineCollection, defineDocument } from '../src/documents.js';

const allow = { canRead: true, canWrite: true, canComment: true };
const expectString = (_value: string) => {};

const config = defineConfig({
  engine: 'yjs',
  documents: {
    // Plain object literal: params come from the key, no type parameter.
    'researches/:id/writing': {
      engine: 'yjs',
      async authorize(_ctx, { docName, params }) {
        expectString(docName);
        expectString(params.id);
        // @ts-expect-error the pattern declares `:id`, not `:researchId`
        expectString(params.researchId);
        return allow;
      },
    },
    // Two params, one of them not named `id`.
    'workspaces/:workspaceId/whiteboards/:boardId': {
      engine: 'automerge',
      async authorize(_ctx, { params }) {
        expectString(params.workspaceId);
        expectString(params.boardId);
        // @ts-expect-error `id` is not a segment of this pattern
        expectString(params.id);
        return allow;
      },
    },
    // No params at all: `params` is `{}`, not a loose record.
    announcements: {
      async authorize(_ctx, { params }) {
        // @ts-expect-error a pattern without `:segments` has no params
        expectString(params.id);
        return allow;
      },
    },
    // A collection is `<prefix>/:id` — the key is built for you, `params.id` typed.
    ...defineCollection('boards', {
      engine: 'automerge',
      async authorize(_ctx, { params }) {
        expectString(params.id);
        // @ts-expect-error a collection is keyed by `:id`, nothing else
        expectString(params.boardId);
        return allow;
      },
    }),
    ...defineCollection('announcements/pinned'),
    // `defineDocument` still works inline and infers `P` from the key.
    'forms/:id': defineDocument({
      async authorize(_ctx, { params }) {
        expectString(params.id);
        // @ts-expect-error inferred from the key, so a wrong name is still caught
        expectString(params.formId);
        return allow;
      },
    }),
    // An explicit `P` that matches the key is accepted.
    'invoices/:id': defineDocument<{ id: string }>({ engine: 'yjs' }),
    // @ts-expect-error an explicit `P` that contradicts the key is rejected at the config
    'contracts/:contractId': defineDocument<{ id: string }>({
      async authorize(_ctx, { params }) {
        expectString(params.id);
        return allow;
      },
    }),
  },
});

// The narrowed config is still what the provider reads.
const widened: CollaborationAppConfig = config;

type Names = InferCollabDocumentNames<typeof config>;

const declared: Names = 'researches/:id/writing';
const alsoDeclared: Names = 'workspaces/:workspaceId/whiteboards/:boardId';
const collection: Names = 'boards/:id';
const nestedCollection: Names = 'announcements/pinned/:id';
// @ts-expect-error a document the config never declares is not a declared name
const undeclared: Names = 'reviews/:id';

// A config without `documents` declares no names.
const bare = defineConfig({ engine: 'yjs' });
type BareNames = InferCollabDocumentNames<typeof bare>;
// @ts-expect-error nothing is declared, so nothing is a declared name
const bareName: BareNames = 'researches/:id/writing';

type Writing = CollabDocumentNameFor<'researches/:id/writing'>;

const resolved: Writing = 'researches/42/writing';
// @ts-expect-error the pattern has to match, not merely be some string
const misspelled: Writing = 'research/42/writing';

// `DocumentParams` on its own, for callers that want the shape by pattern.
const nested: DocumentParams<'workspaces/:workspaceId/whiteboards/:boardId'> = {
  workspaceId: 'w1',
  boardId: 'b1',
};
// @ts-expect-error a runtime-style `string` pattern stays loose, a literal one does not
const loose: DocumentParams<'researches/:id/writing'> = { anything: 'goes' };
const runtime: DocumentParams<string> = { anything: 'goes' };

export const used = [
  widened,
  declared,
  alsoDeclared,
  collection,
  nestedCollection,
  undeclared,
  bareName,
  resolved,
  misspelled,
  nested,
  loose,
  runtime,
];
