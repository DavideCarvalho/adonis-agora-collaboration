import { describe, expect, it, vi } from 'vitest';
import { verifyPartyKitToken } from '../src/drivers/partykit/partykit_driver.js';
import type { CollabHttpContext, CollabManagerLike, CollabRouteUser } from '../src/http/types.js';
import { CollabUnauthorizedError } from '../src/http/types.js';
import { collaborationRoutes } from '../src/routes.js';

const SECRET = 'test-secret-32-chars-minimum-ok!';

/* ── fakes ───────────────────────────────────────────────────────────── */

function makeManager(): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getDocumentState(docName) {
      calls.push(`state:${docName}`);
      return new Uint8Array([1, 2, 3]);
    },
    async createVersion(docName, createdBy, label) {
      calls.push(`version:${docName}:${createdBy}:${label}`);
      return { id: 'v1', seq: 1 };
    },
    async listVersions(docName) {
      calls.push(`versions:${docName}`);
      return [];
    },
    async restoreVersion() {},
    async persistDocument(docName, state) {
      calls.push(`persist:${docName}:${state.byteLength}`);
    },
    comments: {
      async list(docName) {
        calls.push(`comments:${docName}`);
        return [{ id: 'c1' }];
      },
      async create(docName, comment) {
        calls.push(`comment-create:${JSON.stringify(comment)}`);
        return { id: 'c2', ...comment };
      },
      async resolve(docName, commentId, resolved) {
        calls.push(`comment-resolve:${commentId}:${resolved}`);
        return null;
      },
      async remove(docName, commentId) {
        calls.push(`comment-remove:${commentId}`);
        return true;
      },
    },
  };
}

interface RecordedRoute {
  method: string;
  pattern: string;
  handler: (ctx: CollabHttpContext) => Promise<unknown>;
}

function makeRouter() {
  const routes: RecordedRoute[] = [];
  let groupMiddleware: unknown[] = [];

  const router = {
    group(callback: () => void) {
      callback();
      return {
        prefix(prefix: string) {
          void prefix;
          return this;
        },
        middleware(middleware: unknown[]) {
          groupMiddleware = middleware;
          return this;
        },
      };
    },
    get(pattern: string, handler: RecordedRoute['handler']) {
      routes.push({ method: 'GET', pattern, handler });
    },
    post(pattern: string, handler: RecordedRoute['handler']) {
      routes.push({ method: 'POST', pattern, handler });
    },
    patch(pattern: string, handler: RecordedRoute['handler']) {
      routes.push({ method: 'PATCH', pattern, handler });
    },
    delete(pattern: string, handler: RecordedRoute['handler']) {
      routes.push({ method: 'DELETE', pattern, handler });
    },
  };

  return {
    router,
    routes,
    getMiddleware: () => groupMiddleware,
    find(method: string, pattern: string): RecordedRoute {
      const route = routes.find((r) => r.method === method && r.pattern === pattern);
      if (!route) throw new Error(`route not registered: ${method} ${pattern}`);
      return route;
    },
  };
}

function makeCtx(input: {
  qs?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
  raw?: ArrayBuffer;
  headers?: Record<string, string>;
  user?: unknown;
}) {
  const responses: Array<{ status?: number; payload?: unknown }> = [];
  const headersOut: Record<string, string> = {};
  let sentBody: unknown;

  const ctx = {
    __responses: responses,
    get __sentBody() {
      return sentBody;
    },
    get __lastHeader() {
      return headersOut;
    },
    request: {
      qs: () => input.qs ?? {},
      params: input.params ?? {},
      body: <T>() => (input.body ?? {}) as T,
      raw: () => input.raw,
      header: (name: string) => input.headers?.[name],
    },
    response: {
      status(code: number) {
        return {
          json: (payload: unknown) => {
            responses.push({ status: code, payload });
            return payload;
          },
        };
      },
      json(payload: unknown) {
        responses.push({ payload });
        return payload;
      },
      send(payload: unknown) {
        sentBody = payload;
        return payload;
      },
      noContent() {
        responses.push({ status: 204 });
        return undefined;
      },
      header(name: string, value: string) {
        headersOut[name] = value;
        return undefined;
      },
    },
    auth: { user: input.user },
  };

  return ctx as typeof ctx & CollabHttpContext;
}

const authResolver = (ctx: CollabHttpContext): CollabRouteUser => {
  const user = ctx.auth?.user as { id: string; name?: string } | undefined;
  if (!user) throw new Error('unauthenticated');
  return { id: String(user.id), name: user.name ?? null };
};

function baseOptions(manager: CollabManagerLike) {
  return {
    manager,
    engine: 'yjs',
    path: '/collaboration',
    resolveUser: authResolver,
  };
}

/* ── registration shape ──────────────────────────────────────────────── */

describe('collaborationRoutes registration', () => {
  it('registers all endpoints under /collaboration', async () => {
    const { router, routes } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const patterns = routes.map((r) => `${r.method} ${r.pattern}`).sort();
    expect(patterns).toEqual(
      [
        'DELETE /comments/:id',
        'GET /comments',
        'GET /state',
        'GET /token',
        'GET /versions',
        'PATCH /comments/:id',
        'POST /comments',
        'POST /state',
        'POST /versions',
        'POST /versions/restore',
      ].sort(),
    );
  });

  it('applies configured middleware to the group', async () => {
    const { router, getMiddleware } = makeRouter();
    const guard = vi.fn();
    await collaborationRoutes(router, { ...baseOptions(makeManager()), middleware: [guard] });
    expect(getMiddleware()).toEqual([guard]);
  });
});

/* ── handlers behavior ───────────────────────────────────────────────── */

describe('token endpoint', () => {
  it('returns a base64 token for self-hosted engines', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const ctx = makeCtx({ qs: { doc: 'docs/1' }, user: { id: 7, name: 'Ana' } });
    const result = (await find('GET', '/token').handler(ctx)) as {
      token: string;
      wsUrl: string;
      engine: string;
    };

    expect(result).toMatchObject({ wsUrl: '/collaboration', engine: 'yjs' });
    const decoded = JSON.parse(Buffer.from(result.token, 'base64').toString());
    expect(decoded).toMatchObject({ userId: '7', user: { name: 'Ana' } });
  });

  it('signs a JWT and points to the party room for engine=partykit', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(makeManager()),
      engine: 'partykit',
      partykit: { jwtSecret: SECRET, roomHost: 'my-app.partykit.dev' },
    });

    const ctx = makeCtx({ qs: { doc: 'docs/2' }, user: { id: 'u9' } });
    const payload = (await find('GET', '/token').handler(ctx)) as {
      token: string;
      wsUrl: string;
      engine: string;
    };
    expect(payload.engine).toBe('partykit');
    expect(payload.wsUrl).toBe('wss://my-app.partykit.dev/parties/main/docs%2F2');
    expect(verifyPartyKitToken(payload.token, SECRET)?.docName).toBe('docs/2');
  });

  it('rejects missing doc with 400', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const ctx = makeCtx({ user: { id: 'u1' } });
    await find('GET', '/token').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(400);
  });

  it('fails closed with 401 when no user resolves', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      manager: makeManager(),
      engine: 'yjs',
      resolveUser: () => null,
    });

    const ctx = makeCtx({ qs: { doc: 'd' } });
    await find('GET', '/token').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(401);
  });

  it('maps CollabUnauthorizedError from the resolver to 401', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      manager: makeManager(),
      engine: 'yjs',
      resolveUser: () => {
        throw new CollabUnauthorizedError();
      },
    });

    const ctx = makeCtx({ qs: { doc: 'd' } });
    await find('GET', '/token').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(401);
  });
});

describe('comments + versions endpoints', () => {
  it('delegates to the manager surface', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(manager));

    const listCtx = makeCtx({ qs: { doc: 'd/1', space: 'text' } });
    await find('GET', '/comments').handler(listCtx);

    const createCtx = makeCtx({
      body: { docName: 'd/1', space: 'text', anchor: {}, body: 'note', userId: 'u1' },
    });
    await find('POST', '/comments').handler(createCtx);

    const versionCtx = makeCtx({ body: { docName: 'd/1', label: 'v', userId: 'u1' } });
    await find('POST', '/versions').handler(versionCtx);

    expect(manager.calls.some((c) => c.startsWith('comments:d/1'))).toBe(true);
    expect(manager.calls.some((c) => c.includes('"body":"note"'))).toBe(true);
    expect(manager.calls.some((c) => c === 'version:d/1:u1:v')).toBe(true);
  });
});

describe('state endpoints', () => {
  it('GET returns binary state with octet-stream content type', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const ctx = makeCtx({ qs: { doc: 'docs/1' } });
    await find('GET', '/state').handler(ctx);

    expect(ctx.__lastHeader['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(ctx.__sentBody as Buffer)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('POST requires the worker shared secret', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(manager),
      partykit: { jwtSecret: SECRET },
    });

    const noSecret = makeCtx({
      qs: { doc: 'docs/1' },
      raw: new Uint8Array([9]).buffer,
    });
    await find('POST', '/state').handler(noSecret);
    expect(noSecret.__responses[0]!.status).toBe(403);

    const withSecret = makeCtx({
      qs: { doc: 'docs/1' },
      headers: { 'x-collab-worker-secret': SECRET },
      raw: new Uint8Array([9]).buffer,
    });
    await find('POST', '/state').handler(withSecret);
    expect(withSecret.__responses[0]!.status).toBe(204);
    expect(manager.calls.some((c) => c === 'persist:docs/1:1')).toBe(true);
  });

  it('POST returns 501 without a storage-backed manager', async () => {
    const manager = makeManager() as CollabManagerLike & Record<string, unknown>;
    Reflect.deleteProperty(manager, 'persistDocument');

    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(manager),
      partykit: { jwtSecret: SECRET },
    });

    const ctx = makeCtx({
      qs: { doc: 'docs/1' },
      headers: { 'x-collab-worker-secret': SECRET },
      raw: new Uint8Array([9]).buffer,
    });
    await find('POST', '/state').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(501);
  });
});
