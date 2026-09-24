/**
 * Compile-time proof that Adonis's own objects satisfy the structural contracts the routes
 * accept, so an app registers them with no `as unknown as` and no hand-typed `ctx`.
 * Checked by `pnpm typecheck` (tsconfig.json includes this folder); never executed.
 */
import type { HttpContext, Router } from '@adonisjs/core/http';
import type { CollabHttpContext } from '../../src/http/types.js';
import type { CollaborationRouterContract } from '../../src/routes.js';

export function contextFits(ctx: HttpContext): CollabHttpContext {
  return ctx;
}

export function routerFits(router: Router): CollaborationRouterContract {
  return router;
}
