import { describe, expect, it } from 'vitest';
import {
  COLLAB_TOKEN_TTL_SECONDS,
  CollabForbiddenError,
  verifyCollabToken,
  verifyPartyKitToken,
} from '../src/auth/token.js';
import type { CollabHttpContext, CollabManagerLike } from '../src/http/types.js';
import { CollabUnauthorizedError } from '../src/http/types.js';
import { collaborationRoutes, issueCollaborationToken } from '../src/routes.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

/**
 * A token issued outside the route, so the browser can open the socket
 * without a `GET /collaboration/token` in front of it.
 *
 * The two things these tests exist to hold:
 *
 *  - the shortcut is not a hole. `authorize` runs, `engineFor` runs, `wsUrl`
 *    is built the same way — a credential minted from a controller must be
 *    indistinguishable from one the route would have issued for the same
 *    caller, or the permission seam has a second door with a different lock;
 *  - it fails **closed** and it fails *loudly*: no caller is an exception,
 *    not a token for "someone".
 */

const DOC = 'researches/42/writing';
const SECRET = 'test-secret-32-chars-minimum-ok!';
const jane = { id: 'u_1', name: 'Jane' };

function makeManager(
  permission: { canRead: boolean; canWrite: boolean; canComment: boolean },
  engine?: string,
): CollabManagerLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async tokenSecret() {
      return TEST_TOKEN_SECRET;
    },
    async authorize(_ctx, docName) {
      calls.push(`authorize:${docName}`);
      return permission;
    },
    ...(engine
      ? {
          async engineFor({ docName }: { docName: string }) {
            calls.push(`engineFor:${docName}`);
            return engine;
          },
        }
      : {}),
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
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        return {};
      },
      async resolve() {
        return null;
      },
      async remove() {
        return false;
      },
    },
  };
}

const ALLOW = { canRead: true, canWrite: true, canComment: true };
const DENY = { canRead: false, canWrite: false, canComment: false };

describe('issueCollaborationToken', () => {
  it('issues a self-hosted credential carrying engine and wsUrl', async () => {
    const manager = makeManager(ALLOW);

    const issued = await issueCollaborationToken(
      { user: jane, docName: DOC },
      { manager, engine: 'yjs', path: '/collaboration' },
    );

    // engine and wsUrl travel with the token on purpose: without them the
    // client cannot build a transport, and fetching the missing halves would
    // put back the round-trip this whole API removes.
    expect(issued.engine).toBe('yjs');
    expect(issued.wsUrl).toBe('/collaboration');
    expect(verifyCollabToken(issued.token, TEST_TOKEN_SECRET, DOC)).toMatchObject({
      userId: 'u_1',
      docName: DOC,
      user: { name: 'Jane' },
    });
    // It reports its own death, because a page prop sits in the HTML for as
    // long as the tab is open and the client has to be able to discard it
    // without opening a socket to find out.
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(manager.calls).toContain(`authorize:${DOC}`);
  });

  it('resolves the engine per document, exactly as the route does', async () => {
    const manager = makeManager(ALLOW, 'partykit');

    const issued = await issueCollaborationToken(
      { user: jane, docName: DOC },
      {
        manager,
        engine: 'yjs',
        partykit: { roomHost: 'party.example.com', jwtSecret: SECRET, party: 'main' },
      },
    );

    // `engine: 'yjs'` in the options is the *fallback*; the manager decides.
    expect(manager.calls).toContain(`engineFor:${DOC}`);
    expect(issued.engine).toBe('partykit');
    expect(issued.wsUrl).toBe(`wss://party.example.com/parties/main/${encodeURIComponent(DOC)}`);
    expect(verifyPartyKitToken(issued.token, SECRET, DOC)).toMatchObject({
      userId: 'u_1',
      docName: DOC,
    });
  });

  it('reports when the edge credential dies, so a stale page prop can be discarded', async () => {
    const manager = makeManager(ALLOW, 'partykit');
    const before = Date.now();

    const issued = await issueCollaborationToken(
      { user: jane, docName: DOC },
      { manager, partykit: { roomHost: 'party.example.com', jwtSecret: SECRET } },
    );

    // A pre-issued token sits in the HTML for as long as the tab is open. The
    // client has to be able to tell "already dead" from "worth trying"
    // without opening a socket to find out.
    expect(issued.expiresAt).toBeGreaterThanOrEqual(before + COLLAB_TOKEN_TTL_SECONDS * 1000);
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + COLLAB_TOKEN_TTL_SECONDS * 1000 + 50);
  });

  it('enforces authorize — the controller path is not a way around the rule', async () => {
    const manager = makeManager(DENY);

    await expect(
      issueCollaborationToken({ user: jane, docName: DOC }, { manager, engine: 'yjs' }),
    ).rejects.toBeInstanceOf(CollabForbiddenError);
    expect(manager.calls).toContain(`authorize:${DOC}`);
  });

  it('denies when nothing anywhere declares a rule', async () => {
    // A manager without `authorize` leaves the runtime with no rule to run,
    // and an absent rule is a misconfiguration, not a grant.
    const manager = makeManager(ALLOW);
    manager.authorize = undefined;

    await expect(
      issueCollaborationToken({ user: jane, docName: DOC }, { manager, engine: 'yjs' }),
    ).rejects.toBeInstanceOf(CollabForbiddenError);
  });

  it('produces the token the route would have produced for the same caller', async () => {
    const manager = makeManager(ALLOW, 'yjs');
    const options = { manager, engine: 'yjs', path: '/collab-ws' };

    const routes: Array<(ctx: CollabHttpContext) => Promise<unknown>> = [];
    const group = { prefix: () => group, middleware: () => group };
    const router = {
      group(callback: () => void) {
        callback();
        return group;
      },
      get(_pattern: string, handler: unknown) {
        routes.push(handler as (ctx: CollabHttpContext) => Promise<unknown>);
      },
      post() {},
      patch() {},
      delete() {},
    };
    collaborationRoutes(router as never, { ...options, resolveUser: async () => jane });

    const fromRoute = (await routes[0]!({
      request: { qs: () => ({ doc: DOC }) },
      response: {
        status() {
          throw new Error('the route should not have failed');
        },
      },
    } as unknown as CollabHttpContext)) as { token: string; wsUrl: string; engine: string };

    const preIssued = await issueCollaborationToken({ user: jane, docName: DOC }, options);

    // Not byte for byte any more — the token carries `iat`/`exp`, so two
    // issued in different seconds differ legitimately. What must match is
    // everything the handshake and the client actually read: the same claims,
    // signed with the same key, for the same document, plus the transport
    // details the client builds from.
    expect(preIssued.engine).toBe(fromRoute.engine);
    expect(preIssued.wsUrl).toBe(fromRoute.wsUrl);
    const claims = (token: string) => {
      const verified = verifyCollabToken(token, TEST_TOKEN_SECRET, DOC);
      return verified && { userId: verified.userId, docName: verified.docName };
    };
    expect(claims(preIssued.token)).toEqual({ userId: jane.id, docName: DOC });
    expect(claims(preIssued.token)).toEqual(claims(fromRoute.token));
  });
});

describe('issueCollaborationToken user resolution', () => {
  it('resolves the caller from the request with the routes own resolver', async () => {
    const manager = makeManager(ALLOW);
    // authkit-shaped context: `user` is never populated, the guard answers
    // questions instead.
    const ctx = {
      auth: {
        async check() {
          return true;
        },
        getUserOrFail() {
          return { id: 77, name: 'Ana' };
        },
      },
    } as unknown as CollabHttpContext;

    const issued = await issueCollaborationToken({ ctx, docName: DOC }, { manager, engine: 'yjs' });

    expect(verifyCollabToken(issued.token, TEST_TOKEN_SECRET, DOC)).toMatchObject({
      userId: '77',
      user: { name: 'Ana' },
    });
  });

  it('honours an explicit resolveUser override', async () => {
    const manager = makeManager(ALLOW);

    const issued = await issueCollaborationToken(
      { ctx: {} as CollabHttpContext, docName: DOC },
      { manager, engine: 'yjs', resolveUser: async () => ({ id: 'u_9', name: 'Nine' }) },
    );

    expect(verifyCollabToken(issued.token, TEST_TOKEN_SECRET, DOC)).toMatchObject({
      userId: 'u_9',
      user: { name: 'Nine' },
    });
  });

  it('refuses to issue for nobody', async () => {
    const manager = makeManager(ALLOW);

    await expect(
      issueCollaborationToken(
        { ctx: {} as CollabHttpContext, docName: DOC },
        { manager, engine: 'yjs' },
      ),
    ).rejects.toBeInstanceOf(CollabUnauthorizedError);

    await expect(
      issueCollaborationToken(
        { ctx: {} as CollabHttpContext, docName: DOC },
        { manager, engine: 'yjs', resolveUser: async () => null },
      ),
    ).rejects.toBeInstanceOf(CollabUnauthorizedError);
  });

  it('names the mistake when neither a user nor a request is given', async () => {
    await expect(issueCollaborationToken({ docName: DOC })).rejects.toThrow(
      /pass either "user" or "ctx"/,
    );
    await expect(issueCollaborationToken({ docName: '', user: jane })).rejects.toThrow(
      /"docName" is required/,
    );
  });
});
