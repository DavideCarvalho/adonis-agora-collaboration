import { describe, expect, it } from 'vitest';
import { CollabForbiddenError, issueToken } from '../src/auth/token.js';
import type { CollabHttpContext, CollabManagerLike } from '../src/http/types.js';
import { collaborationRoutes, defaultResolveUser } from '../src/routes.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

/**
 * Manual registration — `collaborationRoutes(router)` from `start/routes.ts` —
 * used to behave differently from the provider's, in two ways that pulled in
 * opposite directions:
 *
 *  - `authorize` was read from the options only, so in manual mode there was
 *    none: `guard()` fell to its deny literal (403 for everyone on
 *    `/comments`, `/versions`, `/state`) while `issueToken` skipped the check
 *    entirely (a token for any document, for any authenticated caller);
 *  - the function was `async`, so it could not be called inside
 *    `router.group()` — the group closes synchronously and everything
 *    registered after the first `await` lands outside it.
 *
 * Both are the same absent variable and the same absent `await`. Neither may
 * come back.
 */

const DOC = 'researches/42/writing';
const jane = { id: 'u_1', name: 'Jane' };

function makeManager(permission: {
  canRead: boolean;
  canWrite: boolean;
  canComment: boolean;
}): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    // The manager resolves the rule from config/collaboration.ts — declared
    // document first, then the global authorize, then deny.
    async authorize(_ctx, docName) {
      calls.push(`authorize:${docName}`);
      return permission;
    },
    async getDocumentState() {
      calls.push('state');
      return new Uint8Array([1]);
    },
    async createVersion() {
      calls.push('version');
      return {};
    },
    async listVersions() {
      calls.push('versions');
      return [];
    },
    async restoreVersion() {
      calls.push('restore');
    },
    comments: {
      async list() {
        calls.push('comments');
        return [];
      },
      async create() {
        return {};
      },
      async resolve() {
        return null;
      },
      async remove() {
        return true;
      },
    },
  };
}

interface Recorded {
  method: string;
  pattern: string;
  inGroup: boolean;
  handler: (ctx: CollabHttpContext) => Promise<unknown>;
}

/** A router that remembers whether a group was still open at registration. */
function makeRouter() {
  const routes: Recorded[] = [];
  let groupDepth = 0;

  const group = {
    prefix() {
      return group;
    },
    middleware() {
      return group;
    },
    use() {
      return group;
    },
  };

  const record = (method: string) => (pattern: string, handler: Recorded['handler']) => {
    routes.push({ method, pattern, inGroup: groupDepth > 0, handler });
  };

  const router = {
    group(callback: () => void) {
      groupDepth++;
      callback();
      // Adonis closes the group the moment the callback returns — this is
      // precisely why an async registration function cannot be used here.
      groupDepth--;
      return group;
    },
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  };

  return {
    router,
    routes,
    find(method: string, pattern: string): Recorded {
      const route = routes.find((r) => r.method === method && r.pattern === pattern);
      if (!route) throw new Error(`route not registered: ${method} ${pattern}`);
      return route;
    },
  };
}

function makeCtx(input: { qs?: Record<string, unknown>; user?: unknown }) {
  const responses: Array<{ status: number; payload: unknown }> = [];
  return {
    __responses: responses,
    request: {
      qs: () => input.qs ?? {},
      params: {},
      body: <T>() => ({}) as T,
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

/* ── authorize reaches manual mode ───────────────────────────────────── */

describe('manual mode resolves authorize from the app, not from the options', () => {
  it('serves a document the app grants — without an explicit authorize option', async () => {
    const manager = makeManager({ canRead: true, canWrite: true, canComment: true });
    const { router, find } = makeRouter();
    collaborationRoutes(router, { manager, resolveUser: () => jane });

    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });
    await find('GET', '/comments').handler(ctx);

    // Used to answer 403 for everyone: with no `authorize` option the guard
    // fell straight to its deny literal.
    expect(ctx.__responses).toEqual([]);
    expect(manager.calls).toEqual([`authorize:${DOC}`, 'comments']);
  });

  it('refuses a token for a document the app denies — without an explicit authorize option', async () => {
    const manager = makeManager({ canRead: false, canWrite: false, canComment: false });
    const { router, find } = makeRouter();
    collaborationRoutes(router, { manager, resolveUser: () => jane });

    const ctx = makeCtx({ qs: { doc: DOC }, user: jane });
    await find('GET', '/token').handler(ctx);

    // Used to mint a token for any docName: `issueToken` skipped the check
    // when it received no authorize.
    expect(ctx.__responses[0]?.status).toBe(403);
  });

  it('still fails closed when neither the options nor the app declare a rule', async () => {
    const manager = makeManager({ canRead: true, canWrite: true, canComment: true });
    Reflect.deleteProperty(manager, 'authorize');

    const { router, find } = makeRouter();
    collaborationRoutes(router, { manager, resolveUser: () => jane });

    const read = makeCtx({ qs: { doc: DOC }, user: jane });
    await find('GET', '/comments').handler(read);
    expect(read.__responses[0]?.status).toBe(403);

    const token = makeCtx({ qs: { doc: DOC }, user: jane });
    await find('GET', '/token').handler(token);
    expect(token.__responses[0]?.status).toBe(403);
  });
});

describe('issueToken', () => {
  it('refuses to mint a credential when it has no rule to apply', async () => {
    await expect(
      issueToken({ engine: 'yjs', path: '/collaboration' }, { id: 'u_1' }, DOC),
    ).rejects.toBeInstanceOf(CollabForbiddenError);
  });

  it('mints one when the rule grants read', async () => {
    const issued = await issueToken(
      { engine: 'yjs', path: '/collaboration', tokenSecret: TEST_TOKEN_SECRET },
      { id: 'u_1' },
      DOC,
      async () => ({ canRead: true, canWrite: true, canComment: true }),
    );
    expect(issued.engine).toBe('yjs');
  });
});

/* ── composable inside a group ───────────────────────────────────────── */

describe('collaborationRoutes is synchronous', () => {
  it('registers inside an enclosing router.group(), so app middleware wraps it', () => {
    const manager = makeManager({ canRead: true, canWrite: true, canComment: true });
    const { router, routes } = makeRouter();

    // Exactly what an app writes to put these behind its own auth stack.
    const result = router.group(() => {
      collaborationRoutes(router, { manager });
    });
    result.use();

    expect(routes).toHaveLength(10);
    expect(routes.every((route) => route.inGroup)).toBe(true);
  });

  it('returns nothing to await', () => {
    const { router } = makeRouter();
    const returned = collaborationRoutes(router, {
      manager: makeManager({
        canRead: true,
        canWrite: true,
        canComment: true,
      }),
    });
    expect(returned).toBeUndefined();
  });
});

/* ── the default resolver authenticates ──────────────────────────────── */

describe('defaultResolveUser', () => {
  it('authenticates before reading the user, for a lazily-resolving auth stack', async () => {
    const auth = {
      user: undefined as unknown,
      async check() {
        // What @adonisjs/auth does: the guard populates ctx.auth.user here,
        // and nowhere else. Reading .user without this is always undefined.
        this.user = { id: 9, name: 'Ana' };
        return true;
      },
    };

    const user = await defaultResolveUser({ auth } as unknown as CollabHttpContext);
    expect(user).toEqual({ id: '9', name: 'Ana' });
  });

  it('falls back to authenticate() when the guard exposes no check()', async () => {
    const auth = {
      user: undefined as unknown,
      async authenticate() {
        this.user = { id: 4 };
        return this.user;
      },
    };

    const user = await defaultResolveUser({ auth } as unknown as CollabHttpContext);
    expect(user).toEqual({ id: '4', name: null });
  });

  it('reports a failed authentication as unauthenticated, never as a 500', async () => {
    const auth = {
      async check() {
        throw new Error('token expired');
      },
    };

    await expect(defaultResolveUser({ auth } as unknown as CollabHttpContext)).rejects.toThrow(
      /no authenticated user on context/,
    );
  });

  /**
   * The authkit case. `@adonis-agora/authkit` resolves the user on demand:
   * `check()` returns true and `ctx.auth.user` stays `undefined` forever, so
   * a resolver that only reads `.user` answered 401 for a caller the app
   * considered authenticated — and every app hit by it wrote the same
   * `getUserOrFail()` resolver by hand.
   */
  it('asks a guard that resolves the user on demand instead of populating .user', async () => {
    const auth = {
      user: undefined as unknown,
      async check() {
        // Session verified — and `user` deliberately left alone.
        return true;
      },
      async getUserOrFail() {
        return { id: 77, name: 'Ana' };
      },
    };

    const user = await defaultResolveUser({ auth } as unknown as CollabHttpContext);
    expect(user).toEqual({ id: '77', name: 'Ana' });
    expect(auth.user).toBeUndefined();
  });

  it('prefers getUser() — absence reported by returning, not by throwing', async () => {
    const calls: string[] = [];
    const auth = {
      async getUser() {
        calls.push('getUser');
        return { id: 5 };
      },
      async getUserOrFail() {
        calls.push('getUserOrFail');
        return { id: 6 };
      },
    };

    expect(await defaultResolveUser({ auth } as unknown as CollabHttpContext)).toEqual({
      id: '5',
      name: null,
    });
    expect(calls).toEqual(['getUser']);
  });

  it('falls through to getUserOrFail when getUser has nobody', async () => {
    const auth = {
      async getUser() {
        return null;
      },
      getUserOrFail() {
        return { id: 8, name: 'Bo' };
      },
    };

    expect(await defaultResolveUser({ auth } as unknown as CollabHttpContext)).toEqual({
      id: '8',
      name: 'Bo',
    });
  });

  it('turns a throwing getUserOrFail into a 401, never a 500', async () => {
    const auth = {
      async check() {
        return false;
      },
      async getUserOrFail() {
        throw new Error('E_UNAUTHORIZED_ACCESS: Unauthorized access');
      },
    };

    await expect(defaultResolveUser({ auth } as unknown as CollabHttpContext)).rejects.toThrow(
      /no authenticated user on context/,
    );
  });

  it('refuses a user whose id is empty — an empty caller must never reach authorize', async () => {
    const auth = { user: { id: '   ', name: 'Ghost' } };

    await expect(defaultResolveUser({ auth } as unknown as CollabHttpContext)).rejects.toThrow(
      /no authenticated user on context/,
    );
  });

  it('fails closed with no auth stack at all', async () => {
    await expect(defaultResolveUser({} as unknown as CollabHttpContext)).rejects.toThrow(
      /no authenticated user on context/,
    );
  });
});
