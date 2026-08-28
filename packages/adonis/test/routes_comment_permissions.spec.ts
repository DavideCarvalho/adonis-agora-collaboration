import { describe, expect, it } from 'vitest';
import type { CollabHttpContext, CollabManagerLike } from '../src/http/types.js';
import { canMutateComment, collaborationRoutes } from '../src/routes.js';

/**
 * `canComment` is permission to add an annotation. It was also, accidentally,
 * permission to silence everyone else's: `handleResolveComment` and
 * `handleDeleteComment` checked the document capability and then called
 * `manager.comments.resolve/remove`, which never look at `userId` at all.
 *
 * Creating a comment already refused body-supplied authorship. The mutations
 * now apply the same care: author, or someone who can write the document.
 */

const DOC = 'researches/42/writing';
const jane = { id: 'u_jane', name: 'Jane' };

const comments = [
  { id: 'c_jane', userId: 'u_jane', body: 'mine' },
  { id: 'c_bob', userId: 'u_bob', body: 'theirs' },
];

function makeManager(): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getDocumentState() {
      return new Uint8Array();
    },
    async createVersion() {
      return {};
    },
    async listVersions() {
      return [];
    },
    async restoreVersion() {},
    comments: {
      async list() {
        return comments;
      },
      async create() {
        return {};
      },
      async resolve(_docName, commentId, resolved) {
        calls.push(`resolve:${commentId}:${resolved}`);
        return null;
      },
      async remove(_docName, commentId) {
        calls.push(`remove:${commentId}`);
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
  const group = {
    prefix() {
      return group;
    },
    middleware() {
      return group;
    },
  };
  const router = {
    group(callback: () => void) {
      callback();
      return group;
    },
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  };
  return {
    router,
    find(method: string, pattern: string): Recorded {
      const route = routes.find((r) => r.method === method && r.pattern === pattern);
      if (!route) throw new Error(`route not registered: ${method} ${pattern}`);
      return route;
    },
  };
}

function makeCtx(commentId: string) {
  const responses: Array<{ status: number; payload: unknown }> = [];
  return {
    __responses: responses,
    request: {
      qs: () => ({ doc: DOC }),
      params: { id: commentId },
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
    auth: { user: jane },
  } as unknown as CollabHttpContext & { __responses: typeof responses };
}

function setup(granted: { canWrite: boolean }) {
  const manager = makeManager();
  const { router, find } = makeRouter();
  collaborationRoutes(router, {
    manager,
    resolveUser: () => jane,
    authorize: async () => ({ canRead: true, canWrite: granted.canWrite, canComment: true }),
  });
  return { manager, find };
}

describe('resolving and deleting someone else’s comment', () => {
  it('lets the author resolve their own comment', async () => {
    const { manager, find } = setup({ canWrite: false });
    const ctx = makeCtx('c_jane');

    await find('PATCH', '/comments/:id').handler(ctx);

    expect(ctx.__responses).toEqual([]);
    expect(manager.calls).toEqual(['resolve:c_jane:true']);
  });

  it('lets the author delete their own comment', async () => {
    const { manager, find } = setup({ canWrite: false });
    const ctx = makeCtx('c_jane');

    await find('DELETE', '/comments/:id').handler(ctx);

    expect(manager.calls).toEqual(['remove:c_jane']);
  });

  it('refuses to resolve another user’s comment on canComment alone', async () => {
    const { manager, find } = setup({ canWrite: false });
    const ctx = makeCtx('c_bob');

    await find('PATCH', '/comments/:id').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    // The mutation must not have reached the service.
    expect(manager.calls).toEqual([]);
  });

  it('refuses to delete another user’s comment on canComment alone', async () => {
    const { manager, find } = setup({ canWrite: false });
    const ctx = makeCtx('c_bob');

    await find('DELETE', '/comments/:id').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(403);
    expect(manager.calls).toEqual([]);
  });

  it('allows a user who can write the document to moderate any thread', async () => {
    const { manager, find } = setup({ canWrite: true });
    const ctx = makeCtx('c_bob');

    await find('DELETE', '/comments/:id').handler(ctx);

    expect(ctx.__responses).toEqual([]);
    expect(manager.calls).toEqual(['remove:c_bob']);
  });

  it('answers 404 for a comment that does not exist', async () => {
    const { manager, find } = setup({ canWrite: true });
    const ctx = makeCtx('c_nope');

    await find('PATCH', '/comments/:id').handler(ctx);

    expect(ctx.__responses[0]?.status).toBe(404);
    expect(manager.calls).toEqual([]);
  });
});

describe('canMutateComment', () => {
  const write = { canRead: true, canWrite: true, canComment: true };
  const comment = { canRead: true, canWrite: false, canComment: true };

  it('is true for the author, whatever their document capability', () => {
    expect(
      canMutateComment({ comment: { userId: 'u_1' }, userId: 'u_1', permission: comment }),
    ).toBe(true);
  });

  it('is false for a non-author who can only comment', () => {
    expect(
      canMutateComment({ comment: { userId: 'u_2' }, userId: 'u_1', permission: comment }),
    ).toBe(false);
  });

  it('is true for a non-author who can write the document', () => {
    expect(canMutateComment({ comment: { userId: 'u_2' }, userId: 'u_1', permission: write })).toBe(
      true,
    );
  });

  it('is false for a comment that is not there', () => {
    expect(canMutateComment({ comment: undefined, userId: 'u_1', permission: write })).toBe(false);
  });

  it('does not treat an authorless comment as the caller’s', () => {
    expect(
      canMutateComment({ comment: { userId: null }, userId: 'u_1', permission: comment }),
    ).toBe(false);
  });
});
