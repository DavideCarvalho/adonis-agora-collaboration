import { createHmac, timingSafeEqual } from 'node:crypto';
import { type AuthorizeFn, CollabForbiddenError, issueToken } from './auth/token.js';
import {
  type CollabHttpContext,
  type CollabManagerLike,
  type CollabRouteUser,
  type CollabRoutesRuntime,
  CollabUnauthorizedError,
} from './http/types.js';

/**
 * Built-in REST endpoints for the collaboration package.
 *
 * Two usage modes:
 *
 * 1. **Automatic (default)** — the service provider registers these routes
 *    during boot. Disable with `routes: { enabled: false }` in
 *    `config/collaboration.ts`.
 *
 * 2. **Manual** — call `collaborationRoutes(router)` inside
 *    `start/routes.ts` and apply any middleware you want:
 *
 * ```ts
 * import router from '@adonisjs/core/services/router'
 * import { collaborationRoutes } from '@adonis-agora/collaboration'
 *
 * collaborationRoutes(router, {
 *   middleware: [authMiddleware],
 *   resolveUser: (ctx) => ({ id: String(ctx.auth.user!.id) }),
 * })
 * ```
 *
 * docName always travels via query/body (never a path param): document
 * names contain slashes (e.g. `researches/42/writing`).
 */

/** Resolved runtime snapshot captured by the handler closures. */
interface Runtime {
  engine: string;
  path: string;
  partykit: { roomHost?: string; jwtSecret?: string; party?: string };
  manager(): Promise<CollabManagerLike>;
  authorize?: AuthorizeFn;
}

let cachedAppConfig: Record<string, unknown> | undefined;

async function readAppConfig(): Promise<Record<string, unknown>> {
  if (cachedAppConfig) return cachedAppConfig;
  try {
    // Dynamic + optional: unavailable in plain unit tests.
    const app = (await import('@adonisjs/core/services/app')).default as unknown as {
      config: { get(name: string, fallback: unknown): unknown };
    };
    cachedAppConfig = app.config.get('collaboration', {}) as Record<string, unknown>;
  } catch {
    cachedAppConfig = {};
  }
  return cachedAppConfig;
}

async function resolveRuntime(
  options: CollabRoutesRuntime,
  managerFallback?: () => Promise<CollabManagerLike>,
): Promise<Runtime> {
  const appConfig = (await readAppConfig()) as {
    engine?: string;
    path?: string;
    partykit?: { roomHost?: string; jwtSecret?: string; party?: string };
  };

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

  const appPartykit = appConfig.partykit as
    | { roomHost?: string; jwtSecret?: string; party?: string }
    | undefined;

  return {
    engine: options.engine ?? appConfig.engine ?? 'yjs',
    path: options.path ?? appConfig.path ?? '/collaboration',
    partykit: options.partykit ?? appPartykit ?? {},
    manager: managerFn,
    ...(options.authorize ? { authorize: options.authorize } : {}),
  };
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
): Promise<{ user: CollabRouteUser; docName: string } | { denied: unknown }> {
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

  // No authorize configured at all means the app has not written a rule yet —
  // fail closed rather than serving every document to every caller.
  const permission = runtime.authorize
    ? await runtime.authorize(
        { userId: user.id, ...(user.name ? { user: { name: user.name } } : {}) },
        docName,
      )
    : { canRead: false, canWrite: false, canComment: false };

  if (!permission[capability]) {
    return {
      denied: ctx.response
        .status(403)
        .json({ error: `no ${capability} access to document "${docName}"` }),
    };
  }

  return { user, docName };
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
    const manager = await runtime.manager();
    const engine = manager.engineFor ? await manager.engineFor({ docName }) : runtime.engine;
    return await issueToken(
      { engine, path: runtime.path, partykit: runtime.partykit },
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
  const expectedSecret = runtime.partykit.jwtSecret;
  if (!secretsMatch(ctx.request.header('x-collab-worker-secret'), expectedSecret)) {
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
 */
export async function collaborationRoutes(
  router: CollaborationRouterContract,
  options: CollabRoutesRuntime & { managerFallback?: () => Promise<CollabManagerLike> },
): Promise<void> {
  const runtime = await resolveRuntime(options, options.managerFallback);
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
 * Default auth resolution: read `ctx.auth.user` (populated by @adonisjs/auth
 * when its middleware ran). Throws otherwise so unprotected deployments fail
 * closed with a clear message.
 */
export const defaultResolveUser: NonNullable<CollabRoutesRuntime['resolveUser']> = (ctx) => {
  const user = ctx.auth?.user as { id?: unknown; name?: unknown } | undefined;
  if (!user || user.id === undefined || user.id === null) {
    throw new CollabUnauthorizedError(
      'no authenticated user on context — protect these routes with your auth middleware or provide routes.resolveUser in config/collaboration.ts',
    );
  }
  return { id: String(user.id), name: (user.name as string | undefined) ?? null };
};
