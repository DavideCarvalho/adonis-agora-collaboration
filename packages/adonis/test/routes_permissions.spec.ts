import { describe, expect, it } from 'vitest';
import type { CollabHttpContext, CollabManagerLike } from '../src/http/types.js';
import { collaborationRoutes } from '../src/routes.js';

/**
 * The permission seam has to hold on HTTP, not only on the WebSocket
 * handshake. A rule that denies a document is worth nothing if the same
 * content is readable — or writable — through the built-in REST surface.
 */

function makeManager(): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getDocumentState({ docName }) {
      calls.push(`state:${docName}`);
      return new Uint8Array([1, 2, 3]);
    },
    async createVersion({ docName, createdBy }) {
      calls.push(`version:${docName}:${createdBy}`);
      return { id: 'v1', seq: 1 };
    },
    async listVersions({ docName }) {
      calls.push(`versions:${docName}`);
      return [];
    },
    async restoreVersion({ docName, restoredBy }) {
      calls.push(`restore:${docName}:${restoredBy}`);
    },
    comments: {
      async list(docName) {
        calls.push(`comments:${docName}`);
        return [];
      },
      async create(docName, comment) {
        calls.push(`comment-create:${docName}:${(comment as { userId: string }).userId}`);
        return { id: 'c1', ...comment };
      },
      async resolve(docName, commentId) {
        calls.push(`comment-resolve:${commentId}`);
        return null;
      },
      async remove(docName, commentId) {
        calls.push(`comment-remove:${commentId}`);
        return true;
      },
    },
  };
}

interface Recorded {
  method: string;
  pattern: string;
  handler: (ctx: CollabHttpContext) => Promise<unknown>;
}

function makeRouter() {
  const routes: Recorded[] = [];
  const record = (method: string) => (pattern: string, handler: Recorded['handler']) => {
    routes.push({ method, pattern, handler });
  };
  const router = {
    group(callback: () => void) {
      callback();
      return { prefix: () => router.__group, middleware: () => router.__group };
    },
    __group: { prefix: () => router.__group, middleware: () => router.__group },
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  } as never as Parameters<typeof collaborationRoutes>[0] & { __group: unknown };

  return {
    router,
    find: (method: string, pattern: string) => {
      const route = routes.find((r) => r.method === method && r.pattern === pattern);
      if (!route) throw new Error(`route not registered: ${method} ${pattern}`);
      return route;
    },
  };
}

function makeCtx(input: { qs?: Record<string, unknown>; body?: unknown; user?: unknown }) {
  const responses: Array<{ status: number; payload: unknown }> = [];
  return {
    __responses: responses,
    request: {
      qs: () => input.qs ?? {},
      params: {},
      body: <T>() => (input.body ?? {}) as T,
      raw: () => undefined,
      header: () => undefined,
    },
    response: {
      status(code: number) {
        return {
          json(payload: unknown) {
            responses.push({ status: code, payload });
            return payload;
          },
        };
      },
      json: (payload: unknown) => payload,
      send: (payload: unknown) => payload,
      noContent: () => undefined,
      header: () => undefined,
    },
    auth: { user: input.user },
  } as unknown as CollabHttpContext & { __responses: typeof responses };
}

const DOC = 'researches/42/writing';

/** A rule that grants exactly the capabilities it is given, and nothing else. */
function permissions(granted: Partial<Record<'canRead' | 'canWrite' | 'canComment', boolean>>) {
  return async () => ({
    canRead: granted.canRead ?? false,
    canWrite: granted.canWrite ?? false,
    canComment: granted.canComment ?? false,
  });
}

async function setup(granted: Parameters<typeof permissions>[0]) {
  const manager = makeManager();
  const { router, find } = makeRouter();
  await collaborationRoutes(router, {
    manager,
    authorize: permissions(granted),
    resolveUser: (ctx) => {
      const user = (ctx as { auth?: { user?: { id: string; name?: string } } }).auth?.user;
      return user ? { id: user.id, name: user.name ?? null } : null;
    },
  });
  return { manager, find };
}

const jane = { id: 'u_1', name: 'Jane' };

describe('REST routes enforce the document permission', () => {
  it('refuses to read comments without canRead', async () => {
    const { manager, find } = await setup({ canRead: false });
    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });

    await find('GET', '/comments').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('allows reading comments with canRead', async () => {
    const { manager, find } = await setup({ canRead: true });
    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });

    await find('GET', '/comments').handler(ctx);

    expect(ctx.__responses).toEqual([]);
    expect(manager.calls).toEqual([`comments:${DOC}`]);
  });

  it('refuses to create a comment without canComment', async () => {
    const { manager, find } = await setup({ canRead: true, canComment: false });
    const ctx = makeCtx({ body: { docName: DOC, space: 'text', body: 'hi' }, user: jane });

    await find('POST', '/comments').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('attributes a comment to the authenticated user, not the request body', async () => {
    const { manager, find } = await setup({ canRead: true, canComment: true });
    const ctx = makeCtx({
      body: { docName: DOC, space: 'text', body: 'hi', userId: 'u_someone_else' },
      user: jane,
    });

    await find('POST', '/comments').handler(ctx);

    expect(manager.calls).toEqual([`comment-create:${DOC}:u_1`]);
  });

  it('refuses to create a version without canWrite', async () => {
    const { manager, find } = await setup({ canRead: true, canWrite: false });
    const ctx = makeCtx({ body: { docName: DOC }, user: jane });

    await find('POST', '/versions').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('refuses to restore a version without canWrite', async () => {
    const { manager, find } = await setup({ canRead: true, canWrite: false });
    const ctx = makeCtx({ body: { docName: DOC, versionId: 'v1' }, user: jane });

    await find('POST', '/versions/restore').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('refuses to read the raw state without canRead', async () => {
    const { manager, find } = await setup({ canRead: false });
    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });

    await find('GET', '/state').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('answers 401 when no user is authenticated', async () => {
    const { manager, find } = await setup({ canRead: true });
    const ctx = makeCtx({ qs: { doc: DOC } });

    await find('GET', '/comments').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(401);
    expect(manager.calls).toEqual([]);
  });

  it('fails closed when the app configured no authorize at all', async () => {
    const manager = makeManager();
    const { router, find } = makeRouter();
    await collaborationRoutes(router, {
      manager,
      resolveUser: () => jane,
    });
    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });

    await find('GET', '/comments').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });
});
