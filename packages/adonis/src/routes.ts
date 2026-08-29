import { createHmac, timingSafeEqual } from 'node:crypto';
import { type AuthorizeFn, CollabForbiddenError, issueToken } from './auth/token.js';
import {
  type CollabHttpContext,
  type CollabManagerLike,
  type CollabRouteUser,
  type CollabRoutesRuntime,
  CollabUnauthorizedError,
} from './http/types.js';
import type { CollabPermission } from './types.js';

/**
 * Built-in REST endpoints for the collaboration package.
 *
 * Two usage modes:
 *
 * 1. **Automatic (default)** — the service provider registers these routes
 *    during `boot()`, before the router commits. Disable with
 *    `routes: { enabled: false }` in `config/collaboration.ts`.
 *
 * 2. **Manual** — call `collaborationRoutes(router)` inside
 *    `start/routes.ts` and apply any middleware you want. The call is
 *    **synchronous**, so it composes inside a `router.group()`:
 *
 * ```ts
 * import router from '@adonisjs/core/services/router'
 * import { collaborationRoutes } from '@adonis-agora/collaboration'
 *
 * router.group(() => {
 *   collaborationRoutes(router)
 * }).use(middleware.auth())
 * ```
 *
 * Either way the permission rule is the same one the WebSocket handshake
 * runs: without an explicit `authorize` option the routes resolve it from
 * the manager (and therefore from `config/collaboration.ts`), and fall back
 * to denying rather than to skipping the check.
 *
 * docName always travels via query/body (never a path param): document
 * names contain slashes (e.g. `researches/42/writing`).
 */

/** Engine-shaped settings, resolved lazily at request time. */
interface RuntimeSettings {
  engine: string;
  path: string;
  partykit: { roomHost?: string; jwtSecret?: string; party?: string };
}

/** Resolved runtime captured by the handler closures. */
interface Runtime {
  settings(): Promise<RuntimeSettings>;
  manager(): Promise<CollabManagerLike>;
  /**
   * Always present. When the caller supplies none, this resolves the app's
   * rule through the manager; with no rule anywhere it denies. There is no
   * "no authorize" state a handler can accidentally treat as "no check".
   */
  authorize: AuthorizeFn;
}

/** The permission granted when nothing anywhere declares a rule. */
const DENY_ALL: CollabPermission = { canRead: false, canWrite: false, canComment: false };

/** Shape of `config/collaboration.ts` as far as these routes care. */
interface AppConfigShape {
  engine?: string;
  path?: string;
  partykit?: { roomHost?: string; jwtSecret?: string; party?: string };
  authorize?: AuthorizeFn;
}

let cachedAppConfig: AppConfigShape | undefined;

async function readAppConfig(): Promise<AppConfigShape> {
  if (cachedAppConfig) return cachedAppConfig;
  try {
    // Dynamic + optional: unavailable in plain unit tests.
    const app = (await import('@adonisjs/core/services/app')).default as unknown as {
      config: { get(name: string, fallback: unknown): unknown };
    };
    cachedAppConfig = app.config.get('collaboration', {}) as AppConfigShape;
  } catch {
    cachedAppConfig = {};
  }
  return cachedAppConfig;
}

/**
 * Builds the runtime **synchronously** — every value that needs the booted
 * app is read on first request instead of at registration time. That is what
 * lets `collaborationRoutes` stay synchronous and therefore composable inside
 * `router.group()`.
 */
function resolveRuntime(
  options: CollabRoutesRuntime,
  managerFallback?: () => Promise<CollabManagerLike>,
): Runtime {
  const managerFn = (): Promise<CollabManagerLike> => {
    const provided = options.manager;
    if (provided) {
      return typeof provided === 'function'
        ? Promise.resolve(provided())
        : Promise.resolve(provided);
    }
    if (managerFallback) return managerFallback();
    // Default: booted container singleton via services/main.
    return import('./services/main.js').then(
      (module) => module.default.current as unknown as CollabManagerLike,
    );
  };

  const settings = async (): Promise<RuntimeSettings> => {
    const appConfig = await readAppConfig();
    return {
      engine: options.engine ?? appConfig.engine ?? 'yjs',
      path: options.path ?? appConfig.path ?? '/collaboration',
      partykit: options.partykit ?? appConfig.partykit ?? {},
    };
  };

  /**
   * The asymmetry this closes: `authorize` used to be read from `options`
   * only, so manual mode had none — and one code path then denied everything
   * while another skipped the check entirely. There is exactly one resolution
   * order now, and its last step is a denial.
   */
  const authorize: AuthorizeFn =
    options.authorize ??
    (async (ctx, docName) => {
      const manager = await managerFn().catch(() => undefined);
      if (manager && typeof manager.authorize === 'function') {
        return manager.authorize(ctx, docName);
      }
      const appConfig = await readAppConfig();
      if (typeof appConfig.authorize === 'function') {
        return appConfig.authorize(ctx, docName);
      }
      return DENY_ALL;
    });

  return { settings, manager: managerFn, authorize };
}

/** Timing-safe comparison for shared secrets. */
export function secretsMatch(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const digest = (value: string) =>
    createHmac('sha256', 'collab-worker-secret').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/* ───────────────────────────── permissions ───────────────────────────── */

/**
 * Who may resolve or delete an existing comment.
 *
 * `canComment` is permission to *add* an annotation — it is not permission to
 * silence someone else's. The rule, stated once so it can be tested once:
 *
 *  - the **author** may always resolve or delete their own comment;
 *  - anyone else needs the elevated capability on the document (`canWrite`) —
 *    an editor moderating a thread, not a fellow commenter.
 */
export function canMutateComment(input: {
  comment: { userId?: string | null } | null | undefined;
  userId: string;
  permission: CollabPermission;
}): boolean {
  if (!input.comment) return false;
  if (input.comment.userId != null && String(input.comment.userId) === input.userId) return true;
  return input.permission.canWrite === true;
}

/** Successful guard outcome: who is calling, on what, with which permission. */
interface Allowed {
  user: CollabRouteUser;
  docName: string;
  permission: CollabPermission;
}

/**
 * Resolve the caller and the permission they hold on `docName` — the same
 * `authorize` the WebSocket handshake runs, so a document's rule cannot be
 * bypassed by going through HTTP instead of the socket.
 *
 * Returns a response instead of a permission when the request should stop:
 * `400` without a document, `401` without a user, `403` when the rule denies
 * the capability the route needs.
 */
async function guard(
  ctx: CollabHttpContext,
  runtime: Runtime,
  userResolver: NonNullable<CollabRoutesRuntime['resolveUser']>,
  docName: string | undefined,
  capability: 'canRead' | 'canWrite' | 'canComment',
): Promise<Allowed | { denied: unknown }> {
  if (!docName) {
    return { denied: ctx.response.status(400).json({ error: 'a document name is required' }) };
  }

  let user: CollabRouteUser | null;
  try {
    user = await userResolver(ctx);
  } catch (error) {
    if (error instanceof CollabUnauthorizedError) {
      return { denied: ctx.response.status(401).json({ error: error.message }) };
    }
    throw error;
  }
  if (!user) {
    return { denied: ctx.response.status(401).json({ error: 'unauthenticated' }) };
  }

  const permission = await runtime.authorize(
    { userId: user.id, ...(user.name ? { user: { name: user.name } } : {}) },
    docName,
  );

  if (!permission[capability]) {
    return {
      denied: ctx.response
        .status(403)
        .json({ error: `no ${capability} access to document "${docName}"` }),
    };
  }

  return { user, docName, permission };
}

function isDenied(result: object): result is { denied: unknown } {
  return 'denied' in result;
}

/* ───────────────────────────── handlers ───────────────────────────── */

async function handleToken(
  ctx: CollabHttpContext,
  runtime: Runtime,
  userResolver: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const docName = ctx.request.qs().doc;
  if (!docName || typeof docName !== 'string') {
    return ctx.response.status(400).json({ error: 'query param "doc" is required' });
  }

  let user: CollabRouteUser | null;
  try {
    user = await userResolver(ctx);
  } catch (error) {
    if (error instanceof CollabUnauthorizedError) {
      return ctx.response.status(401).json({ error: error.message });
    }
    throw error;
  }
  if (!user) {
    return ctx.response.status(401).json({ error: 'unauthenticated' });
  }

  try {
    const settings = await runtime.settings();
    const manager = await runtime.manager();
    const engine = manager.engineFor ? await manager.engineFor({ docName }) : settings.engine;
    return await issueToken(
      { engine, path: settings.path, partykit: settings.partykit },
      user,
      docName,
      runtime.authorize,
    );
  } catch (error) {
    if (error instanceof CollabForbiddenError) {
      return ctx.response.status(403).json({ error: error.message });
    }
    throw error;
  }
}

async function handleListComments(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const { doc, space } = ctx.request.qs() as { doc?: string; space?: string };
  const allowed = await guard(ctx, runtime, resolveUser, doc, 'canRead');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  return manager.comments.list(allowed.docName, space);
}

async function handleCreateComment(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const body = ctx.request.body<{
    docName: string;
    space: string;
    anchor: unknown;
    body: string;
    authorName?: string | null;
  }>();
  const allowed = await guard(ctx, runtime, resolveUser, body.docName, 'canComment');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  return manager.comments.create(allowed.docName, {
    space: body.space,
    anchor: body.anchor,
    body: body.body,
    // The author is who the request authenticated as, never who it claims to
    // be: a body-supplied userId would let anyone comment as anyone.
    userId: allowed.user.id,
    authorName: body.authorName ?? allowed.user.name ?? null,
  });
}

/**
 * Loads the comment being mutated and checks {@link canMutateComment}.
 * Returns the response to send when the mutation must not happen.
 */
async function guardCommentMutation(
  ctx: CollabHttpContext,
  manager: CollabManagerLike,
  allowed: Allowed,
  commentId: string,
): Promise<{ denied: unknown } | { ok: true }> {
  // One comment, not the document's whole comment list: this runs on every
  // PATCH and DELETE, and scanning every comment to authorize one of them made
  // the check grow with the discussion.
  const comment = (await manager.comments.get(allowed.docName, commentId)) as
    | { id?: string; userId?: string | null }
    | null
    | undefined;

  if (!comment) {
    return { denied: ctx.response.status(404).json({ error: 'comment not found' }) };
  }
  if (!canMutateComment({ comment, userId: allowed.user.id, permission: allowed.permission })) {
    const error = 'only the comment author, or someone who can write the document, may do that';
    return { denied: ctx.response.status(403).json({ error }) };
  }
  return { ok: true };
}

async function handleResolveComment(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const doc = ctx.request.qs().doc as string | undefined;
  const commentId = String((ctx.request.params as Record<string, unknown> | undefined)?.id ?? '');
  const resolved = Boolean(ctx.request.body<{ resolved?: boolean }>().resolved ?? true);
  const allowed = await guard(ctx, runtime, resolveUser, doc, 'canComment');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  const mutation = await guardCommentMutation(ctx, manager, allowed, commentId);
  if (isDenied(mutation)) return mutation.denied;

  return manager.comments.resolve(allowed.docName, commentId, resolved);
}

async function handleDeleteComment(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const doc = ctx.request.qs().doc as string | undefined;
  const commentId = String((ctx.request.params as Record<string, unknown> | undefined)?.id ?? '');
  const allowed = await guard(ctx, runtime, resolveUser, doc, 'canComment');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  const mutation = await guardCommentMutation(ctx, manager, allowed, commentId);
  if (isDenied(mutation)) return mutation.denied;

  return { deleted: await manager.comments.remove(allowed.docName, commentId) };
}

async function handleListVersions(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const doc = ctx.request.qs().doc as string | undefined;
  const allowed = await guard(ctx, runtime, resolveUser, doc, 'canRead');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  return manager.listVersions({ docName: allowed.docName });
}

async function handleCreateVersion(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const body = ctx.request.body<{ docName: string; label?: string }>();
  const allowed = await guard(ctx, runtime, resolveUser, body.docName, 'canWrite');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  return manager.createVersion({
    docName: allowed.docName,
    createdBy: allowed.user.id,
    label: body.label ?? null,
  });
}

async function handleRestoreVersion(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const body = ctx.request.body<{ docName: string; versionId: string }>();
  const allowed = await guard(ctx, runtime, resolveUser, body.docName, 'canWrite');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  await manager.restoreVersion({
    docName: allowed.docName,
    versionId: body.versionId,
    restoredBy: allowed.user.id,
  });
  return ctx.response.noContent();
}

async function handleGetState(
  ctx: CollabHttpContext,
  runtime: Runtime,
  resolveUser: NonNullable<CollabRoutesRuntime['resolveUser']>,
): Promise<unknown> {
  const doc = ctx.request.qs().doc as string | undefined;
  const allowed = await guard(ctx, runtime, resolveUser, doc, 'canRead');
  if (isDenied(allowed)) return allowed.denied;

  const manager = await runtime.manager();
  const state = await manager.getDocumentState({ docName: allowed.docName });
  ctx.response.header('content-type', 'application/octet-stream');
  return ctx.response.send(Buffer.from(state));
}

async function handleSaveState(ctx: CollabHttpContext, runtime: Runtime): Promise<unknown> {
  const doc = String(ctx.request.qs().doc ?? '');
  if (!doc) {
    return ctx.response.status(400).json({ error: 'query param "doc" is required' });
  }
  const { partykit } = await runtime.settings();
  if (!secretsMatch(ctx.request.header('x-collab-worker-secret'), partykit.jwtSecret)) {
    return ctx.response.status(403).json({ error: 'invalid worker secret' });
  }

  const manager = await runtime.manager();
  if (!manager.persistDocument) {
    return ctx.response.status(501).json({
      error: 'persisting worker snapshots requires a configured storage backend',
    });
  }
  const raw = ctx.request.raw();
  await manager.persistDocument({ docName: doc, state: new Uint8Array(raw ?? new ArrayBuffer(0)) });
  return ctx.response.noContent();
}

/* ───────────────────────────── registration ───────────────────────────── */

/** Minimal structural contract satisfied by the Adonis Router. */
export interface CollabRouteGroupContract {
  prefix(prefix: string): this;
  middleware(middleware: unknown[]): this;
}

export interface CollaborationRouterContract {
  group(callback: () => void): CollabRouteGroupContract;
  get(pattern: string, handler: unknown): unknown;
  post(pattern: string, handler: unknown): unknown;
  patch(pattern: string, handler: unknown): unknown;
  delete(pattern: string, handler: unknown): unknown;
}

/**
 * Registers every collaboration REST endpoint under an optional prefix
 * (default `/collaboration`).
 *
 * **Synchronous on purpose.** `RouteGroup` closes as soon as its callback
 * returns, so anything registered after an `await` lands outside the group —
 * which made it impossible to wrap these routes in an app's own middleware.
 * Everything that needs the booted app is resolved at request time instead.
 */
export function collaborationRoutes(
  router: CollaborationRouterContract,
  options: CollabRoutesRuntime & { managerFallback?: () => Promise<CollabManagerLike> } = {},
): void {
  const runtime = resolveRuntime(options, options.managerFallback);
  const resolveUser = options.resolveUser ?? defaultResolveUser;

  router
    .group(() => {
      registerRoute(router, 'get', '/token', (ctx) => handleToken(ctx, runtime, resolveUser));

      registerRoute(router, 'get', '/comments', (ctx) =>
        handleListComments(ctx, runtime, resolveUser),
      );
      registerRoute(router, 'post', '/comments', (ctx) =>
        handleCreateComment(ctx, runtime, resolveUser),
      );
      registerRoute(router, 'patch', '/comments/:id', (ctx) =>
        handleResolveComment(ctx, runtime, resolveUser),
      );
      registerRoute(router, 'delete', '/comments/:id', (ctx) =>
        handleDeleteComment(ctx, runtime, resolveUser),
      );

      registerRoute(router, 'get', '/versions', (ctx) =>
        handleListVersions(ctx, runtime, resolveUser),
      );
      registerRoute(router, 'post', '/versions', (ctx) =>
        handleCreateVersion(ctx, runtime, resolveUser),
      );
      registerRoute(router, 'post', '/versions/restore', (ctx) =>
        handleRestoreVersion(ctx, runtime, resolveUser),
      );

      registerRoute(router, 'get', '/state', (ctx) => handleGetState(ctx, runtime, resolveUser));
      registerRoute(router, 'post', '/state', (ctx) => handleSaveState(ctx, runtime));
    })
    .prefix(options.prefix ?? '/collaboration')
    .middleware([...(options.middleware ?? [])]);
}

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** Minimal structural registration — keeps the Adonis Router out of our types. */
function registerRoute(
  router: CollaborationRouterContract,
  method: HttpMethod,
  pattern: string,
  handler: (ctx: CollabHttpContext) => Promise<unknown>,
): void {
  router[method](pattern, handler);
}

/**
 * Default auth resolution.
 *
 * Reads `ctx.auth.user` — but *authenticates first* when the auth stack has
 * not run yet. With a lazily-resolving guard `ctx.auth.user` is simply
 * `undefined` until something calls `check()`/`authenticate()`, which is why
 * every app ended up bolting a global middleware onto a hardcoded
 * `/collaboration` prefix. Here `check()` is preferred because it reports
 * failure by returning `false` instead of throwing.
 *
 * Still fails closed: no user, no request.
 */
export const defaultResolveUser: NonNullable<CollabRoutesRuntime['resolveUser']> = async (ctx) => {
  const auth = ctx.auth as
    | {
        user?: unknown;
        isAuthenticated?: boolean;
        check?(): Promise<boolean>;
        authenticate?(): Promise<unknown>;
      }
    | undefined;

  if (auth && !auth.user) {
    try {
      if (typeof auth.check === 'function') {
        await auth.check();
      } else if (typeof auth.authenticate === 'function') {
        await auth.authenticate();
      }
    } catch {
      // A failed authentication is an absent user — reported as 401 below,
      // never as a 500.
    }
  }

  const user = auth?.user as { id?: unknown; name?: unknown } | undefined;
  if (!user || user.id === undefined || user.id === null) {
    throw new CollabUnauthorizedError(
      'no authenticated user on context — protect these routes with your auth middleware or provide routes.resolveUser in config/collaboration.ts',
    );
  }
  return { id: String(user.id), name: (user.name as string | undefined) ?? null };
};
