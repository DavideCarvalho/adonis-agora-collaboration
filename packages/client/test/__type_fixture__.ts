/**
 * Compiled by `discarded_params.spec.ts` through `tsc` (see `tsconfig.fixture.json`) —
 * NOT a test file (vitest only collects `*.spec.ts[x]`), and excluded from the
 * package typecheck along with the rest of `test/`.
 *
 * Every `@ts-expect-error` below is the assertion: `userId` is stamped by the
 * route from the authenticated caller and discarded from the body, so no client
 * signature may ask for one. If a signature takes it back, the suppression
 * becomes unused and tsc reports error 2578.
 */
import type { UseCommentsResult } from '../src/hooks/use_comments.js';
import { createComment, createVersion } from '../src/rest_client.js';
import type { CollabComment, CollaborationClientConfig } from '../src/types.js';

declare const config: CollaborationClientConfig;
declare const create: UseCommentsResult['create'];
const anchor: CollabComment['anchor'] = { kind: 'timestamp', at: 0 };

/* The supported shape: author-free. */
void createVersion(config, 'docs/1', 'before review');
void create({ space: 'text', anchor, body: 'hi' });
void createComment(config, { documentName: 'docs/1', space: 'text', anchor, body: 'hi' });

// @ts-expect-error createVersion no longer takes a userId — the route ignored it.
void createVersion(config, 'docs/1', 'before review', 'u1');

// @ts-expect-error useComments().create no longer demands a userId.
void create({ space: 'text', anchor, body: 'hi', userId: 'u1' });

void createComment(config, {
  documentName: 'docs/1',
  space: 'text',
  anchor,
  body: 'hi',
  // @ts-expect-error createComment no longer takes a userId.
  userId: 'u1',
});
