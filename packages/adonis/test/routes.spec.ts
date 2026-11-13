import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { verifyCollabToken } from '../src/auth/token.js';
import type { CollabHttpContext, CollabManagerLike, CollabRouteUser } from '../src/http/types.js';
import { CollabUnauthorizedError } from '../src/http/types.js';
import { collaborationRoutes } from '../src/routes.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

const SECRET = 'test-secret-32-chars-minimum-ok!';

/* ── fakes ───────────────────────────────────────────────────────────── */

function makeManager(): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    // The routes ask the manager for the signing key, exactly as they ask it
    // for `authorize` — one source for both ends of the credential.
    async tokenSecret() {
      return TEST_TOKEN_SECRET;
    },
    async getDocumentState({ docName }: { docName: string }) {
      calls.push(`state:${docName}`);
      return new Uint8Array([1, 2, 3]);
    },
    async createVersion({
      docName,
      createdBy,
      label,
    }: {
      docName: string;
      createdBy: string | null;
      label: string | null;
    }) {
      calls.push(`version:${docName}:${createdBy}:${label}`);
      return { id: 'v1', seq: 1 };
    },
    async listVersions({
      docName,
      page,
      size,
      order,
    }: {
      docName: string;
      page?: number;
      size?: number;
      order?: 'asc' | 'desc';
    }) {
      calls.push(`versions:${docName}:${page}:${size}`);
      calls.push(`versions-order:${order}`);
      return [{ id: 'v1', seq: 1 }];
    },
    async countVersions({ docName }: { docName: string }) {
      calls.push(`versions-count:${docName}`);
      return 120;
    },
    async restoreVersion() {},
    async persistDocument({ docName, state }: { docName: string; state: Uint8Array }) {
      calls.push(`persist:${docName}:${state.byteLength}`);
    },
    comments: {
      async list(docName, space, page) {
        calls.push(`comments:${docName}:${space}:${page?.page}:${page?.size}`);
        calls.push(`comments-order:${page?.order}`);
        return [{ id: 'c1' }];
      },
      async count(docName, space) {
        calls.push(`comments-count:${docName}:${space}`);
        return 7;
      },
      async create(_docName, comment) {
        calls.push(`comment-create:${JSON.stringify(comment)}`);
        return { id: 'c2', ...comment };
      },
      async resolve(_docName, commentId, resolved) {
        calls.push(`comment-resolve:${commentId}:${resolved}`);
        return null;
      },
      async remove(_docName, commentId) {
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
  raw?: unknown;
  /** The Node request stream, as Adonis leaves it for a type no body parser reads. */
  stream?: AsyncIterable<unknown> & { readableEnded?: boolean };
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
    // Where Adonis puts route params; there `request.params` is a method, not the params.
    params: input.params ?? {},
    request: {
      qs: () => input.qs ?? {},
      params: () => ({}),
      body: <T>() => (input.body ?? {}) as T,
      raw: () => input.raw,
      request: input.stream,
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
    // Delegation tests care about what reaches the manager, not about the
    // permission gate — routes_permissions.spec.ts covers denial.
    authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
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
  it('returns a signed, document-bound token for self-hosted engines', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const ctx = makeCtx({ qs: { doc: 'docs/1' }, user: { id: 7, name: 'Ana' } });
    const result = (await find('GET', '/token').handler(ctx)) as {
      token: string;
      wsUrl: string;
      engine: string;
      expiresAt: number;
    };

    expect(result).toMatchObject({ wsUrl: '/collaboration', engine: 'yjs' });
    // Verified, not decoded: the point of the format is that reading it
    // without the key proves nothing.
    expect(verifyCollabToken(result.token, TEST_TOKEN_SECRET, 'docs/1')).toMatchObject({
      userId: '7',
      docName: 'docs/1',
      user: { name: 'Ana' },
    });
    expect(verifyCollabToken(result.token, TEST_TOKEN_SECRET, 'docs/2')).toBeNull();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
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
    expect(verifyCollabToken(payload.token, SECRET, 'docs/2')?.docName).toBe('docs/2');
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

    const listCtx = makeCtx({ qs: { doc: 'd/1', space: 'text' }, user: { id: 'u1' } });
    await find('GET', '/comments').handler(listCtx);

    const createCtx = makeCtx({
      body: { docName: 'd/1', space: 'text', anchor: {}, body: 'note' },
      user: { id: 'u1' },
    });
    await find('POST', '/comments').handler(createCtx);

    const versionCtx = makeCtx({ body: { docName: 'd/1', label: 'v' }, user: { id: 'u1' } });
    await find('POST', '/versions').handler(versionCtx);

    expect(manager.calls.some((c) => c.startsWith('comments:d/1'))).toBe(true);
    expect(manager.calls.some((c) => c.includes('"body":"note"'))).toBe(true);
    // createdBy comes from the authenticated user now, not from the body.
    expect(manager.calls.some((c) => c === 'version:d/1:u1:v')).toBe(true);
  });
});

/**
 * `GET /versions` and `GET /comments` speak the `@adonis-agora/filter` list
 * wire format: `filter[space]=…`, `sort=…`, 1-based `page` + `size` (default
 * 50, max 200), answered as `{ data, meta }`.
 */
describe('list API (versions + comments)', () => {
  async function setup() {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(manager));
    const get = async (pattern: string, qs: Record<string, unknown>) => {
      const ctx = makeCtx({ qs, user: { id: 'u1' } });
      const result = await find('GET', pattern).handler(ctx);
      return { result, ctx };
    };
    return { manager, get };
  }

  it('answers the offset envelope with the total from the count', async () => {
    const { get } = await setup();

    const versions = await get('/versions', { doc: 'd/1', page: '2', size: '50' });
    expect(versions.result).toEqual({
      data: [{ id: 'v1', seq: 1 }],
      meta: { total: 120, perPage: 50, currentPage: 2, lastPage: 3, firstPage: 1 },
    });

    const comments = await get('/comments', { doc: 'd/1' });
    expect(comments.result).toEqual({
      data: [{ id: 'c1' }],
      meta: { total: 7, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
    });
  });

  it('defaults to page 1 / size 50 when the query string has none', async () => {
    const { manager, get } = await setup();
    await get('/versions', { doc: 'd/1' });
    await get('/comments', { doc: 'd/1' });

    expect(manager.calls).toContain('versions:d/1:1:50');
    expect(manager.calls).toContain('comments:d/1:undefined:1:50');
  });

  it('passes through a requested page/size within bounds', async () => {
    const { manager, get } = await setup();
    await get('/versions', { doc: 'd/1', page: '3', size: '10' });
    await get('/comments', { doc: 'd/1', page: '4', size: '5' });

    expect(manager.calls).toContain('versions:d/1:3:10');
    expect(manager.calls).toContain('comments:d/1:undefined:4:5');
  });

  it('clamps an oversized size and a page below one instead of trusting the client', async () => {
    const { manager, get } = await setup();
    await get('/versions', { doc: 'd/1', page: '-5', size: '999999' });
    expect(manager.calls).toContain('versions:d/1:1:200');
  });

  it('falls back to the default on a garbage (non-numeric) page/size', async () => {
    const { manager, get } = await setup();
    await get('/versions', { doc: 'd/1', page: 'not-a-number', size: 'nope' });
    expect(manager.calls).toContain('versions:d/1:1:50');
  });

  it('dispatches filter[space] to the comment filter and counts the same space', async () => {
    const { manager, get } = await setup();
    await get('/comments', { doc: 'd/1', filter: { space: 'text' }, page: '2', size: '5' });

    expect(manager.calls).toContain('comments:d/1:text:2:5');
    expect(manager.calls).toContain('comments-count:d/1:text');
  });

  it('answers 400 for an unknown filter field', async () => {
    const { manager, get } = await setup();

    const comments = await get('/comments', { doc: 'd/1', filter: { author: 'u2' } });
    expect(comments.ctx.__responses[0]).toMatchObject({ status: 400 });
    expect(String((comments.ctx.__responses[0]!.payload as { error: string }).error)).toContain(
      'author',
    );

    // Versions have no filterable field at all.
    const versions = await get('/versions', { doc: 'd/1', filter: { space: 'text' } });
    expect(versions.ctx.__responses[0]).toMatchObject({ status: 400 });

    expect(manager.calls.some((c) => c.startsWith('comments:'))).toBe(false);
    expect(manager.calls.some((c) => c.startsWith('versions:'))).toBe(false);
  });

  it('answers 400 for an operator the space filter does not support', async () => {
    const { get } = await setup();
    const { ctx } = await get('/comments', {
      doc: 'd/1',
      filter: { space: { contains: 'te' } },
    });
    expect(ctx.__responses[0]).toMatchObject({ status: 400 });
  });

  it('sorts oldest first by default and newest first with the reversed field', async () => {
    const { manager, get } = await setup();

    await get('/versions', { doc: 'd/1' });
    await get('/comments', { doc: 'd/1' });
    expect(manager.calls).toContain('versions-order:asc');
    expect(manager.calls).toContain('comments-order:asc');

    await get('/versions', { doc: 'd/1', sort: '-seq' });
    await get('/comments', { doc: 'd/1', sort: '-createdAt' });
    expect(manager.calls).toContain('versions-order:desc');
    expect(manager.calls).toContain('comments-order:desc');
  });

  it('answers 400 for a sort field outside the allow-list', async () => {
    const { manager, get } = await setup();

    const versions = await get('/versions', { doc: 'd/1', sort: '-createdAt' });
    expect(versions.ctx.__responses[0]).toMatchObject({ status: 400 });

    const comments = await get('/comments', { doc: 'd/1', sort: 'body' });
    expect(comments.ctx.__responses[0]).toMatchObject({ status: 400 });

    const twoKeys = await get('/comments', { doc: 'd/1', sort: 'createdAt,-createdAt' });
    expect(twoKeys.ctx.__responses[0]).toMatchObject({ status: 400 });

    expect(manager.calls.some((c) => c.endsWith('-order:asc'))).toBe(false);
  });

  it('checks the read permission before parsing the listing', async () => {
    const { manager, get } = await setup();
    const { ctx } = await get('/comments', { filter: { nope: 'x' } });
    expect(ctx.__responses[0]).toMatchObject({ status: 400 });
    expect(String((ctx.__responses[0]!.payload as { error: string }).error)).toContain('doc');
    expect(manager.calls).toHaveLength(0);
  });
});

describe('state endpoints', () => {
  it('GET returns binary state with octet-stream content type', async () => {
    const { router, find } = makeRouter();
    await collaborationRoutes(router, baseOptions(makeManager()));

    const ctx = makeCtx({ qs: { doc: 'docs/1' }, user: { id: 'u1' } });
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

  it('POST reads the binary body from the request stream, as Adonis leaves it', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(manager),
      partykit: { jwtSecret: SECRET },
    });

    // Adonis: octet-stream is claimed by no body parser, so raw() is null and the bytes are
    // still on the stream. Persisting `raw() ?? empty` used to store a zero-byte document.
    const ctx = makeCtx({
      qs: { doc: 'docs/1' },
      headers: { 'x-collab-worker-secret': SECRET },
      raw: null,
      stream: Readable.from([Buffer.from([1, 2]), Buffer.from([3])]),
    });
    await find('POST', '/state').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(204);
    expect(manager.calls).toContain('persist:docs/1:3');
  });

  it('POST refuses a stream something upstream already decoded as text', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(manager),
      partykit: { jwtSecret: SECRET },
    });

    const ctx = makeCtx({
      qs: { doc: 'docs/1' },
      headers: { 'x-collab-worker-secret': SECRET },
      raw: null,
      stream: Readable.from(['decoded text']),
    });
    await find('POST', '/state').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(400);
    expect(manager.calls.some((call) => call.startsWith('persist:'))).toBe(false);
  });

  it('POST refuses an empty body instead of overwriting the document with nothing', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      ...baseOptions(manager),
      partykit: { jwtSecret: SECRET },
    });

    const ctx = makeCtx({
      qs: { doc: 'docs/1' },
      headers: { 'x-collab-worker-secret': SECRET },
      raw: null,
    });
    await find('POST', '/state').handler(ctx);
    expect(ctx.__responses[0]!.status).toBe(400);
    expect(manager.calls.some((call) => call.startsWith('persist:'))).toBe(false);
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
