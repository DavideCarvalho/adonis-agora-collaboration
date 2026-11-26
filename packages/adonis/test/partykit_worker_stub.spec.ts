import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  derivePartyKitKey,
  PARTYKIT_HKDF_SALT,
  PARTYKIT_SERVER_KEY_LABEL,
  PARTYKIT_WORKER_SECRET_LABEL,
  partyKitServerKey,
  resolvePartyKitWorkerSecret,
} from '../src/auth/partykit_keys.js';
import { issueToken, signCollabToken } from '../src/auth/token.js';
import { PARTYKIT_SERVER_IDENTITY } from '../src/drivers/partykit/partykit_driver.js';
import {
  PARTYKIT_WORKER_PROTOCOL_MARKER,
  partyKitWorkerStubStatus,
} from '../src/drivers/partykit/worker_stub.js';
import type { CollabHttpContext, CollabManagerLike } from '../src/http/types.js';
import { collaborationRoutes } from '../src/routes.js';

/**
 * The worker template is not just text to grep: it is executed here, with
 * y-partykit replaced by a recorder, so the properties the edge engine's
 * security rests on are checked against the code users actually deploy.
 */

const onConnectSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('y-partykit', () => ({ onConnect: (...args: unknown[]) => onConnectSpy(...args) }));

const here = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.join(here, '../stubs/partykit/worker/party.ts.stub');
const generatedDir = path.join(here, '__generated__');
const generatedWorker = path.join(generatedDir, 'party_worker.ts');

const SECRET = 'test-secret-32-chars-minimum-ok!';
const DOC = 'researches/42/writing';

type WorkerClass = {
  new (
    party: unknown,
  ): {
    onConnect(connection: unknown, ctx: unknown): Promise<void>;
    onRequest(request: Request): Promise<Response>;
    fetchFromAdonis(path: string, init?: { method: 'POST'; body: Uint8Array }): Promise<Response>;
  };
  onBeforeConnect(request: Request, lobby: unknown): Promise<Response | Request>;
};

let Worker: WorkerClass;
let stubSource: string;

beforeAll(async () => {
  stubSource = await readFile(stubPath, 'utf-8');
  // Drop the `{{{ exports(...) }}}` front matter the ace codemod consumes.
  const body = stubSource.replace(/^\{\{\{[\s\S]*?\}\}\}\n/, '');
  await mkdir(generatedDir, { recursive: true });
  await writeFile(generatedWorker, body);
  Worker = (await import(generatedWorker)).default as WorkerClass;
});

afterAll(async () => {
  await rm(generatedDir, { recursive: true, force: true });
});

beforeEach(() => {
  onConnectSpy.mockClear();
});

function party(env: Record<string, string | undefined> = {}) {
  return { name: DOC, env: { COLLAB_JWT_SECRET: SECRET, ADONIS_BASE_URL: 'http://app', ...env } };
}

function roomUrl(query = '') {
  return `https://edge.example/parties/main/${encodeURIComponent(DOC)}${query}`;
}

async function userToken(canWrite: boolean | undefined, docName = DOC) {
  const issued = await issueToken(
    { engine: 'partykit', partykit: { roomHost: 'edge.example', jwtSecret: SECRET } },
    { id: 'u1' },
    docName,
    async () => ({ canRead: true, canWrite: canWrite === true, canComment: false }),
  );
  if (canWrite === undefined) {
    // A token from before the claim existed: same signature, no canWrite.
    return signCollabToken({ userId: 'u1', docName }, SECRET);
  }
  return issued.token;
}

function connection() {
  return { close: vi.fn() };
}

describe('PartyKit worker template — sockets', () => {
  it('opens a reader socket read-only, so its updates are never applied', async () => {
    const worker = new Worker(party());
    const token = await userToken(false);
    await worker.onConnect(connection(), { request: new Request(roomUrl(`?token=${token}`)) });
    expect(onConnectSpy).toHaveBeenCalledTimes(1);
    expect((onConnectSpy.mock.calls[0]![2] as { readOnly: boolean }).readOnly).toBe(true);
  });

  it('opens a writer socket writable', async () => {
    const worker = new Worker(party());
    const token = await userToken(true);
    await worker.onConnect(connection(), { request: new Request(roomUrl(`?token=${token}`)) });
    expect((onConnectSpy.mock.calls[0]![2] as { readOnly: boolean }).readOnly).toBe(false);
  });

  it('treats a token without the canWrite claim as read-only', async () => {
    const worker = new Worker(party());
    const token = await userToken(undefined);
    await worker.onConnect(connection(), { request: new Request(roomUrl(`?token=${token}`)) });
    expect((onConnectSpy.mock.calls[0]![2] as { readOnly: boolean }).readOnly).toBe(true);
  });

  it('closes a socket whose token does not verify instead of syncing it', async () => {
    const worker = new Worker(party());
    const conn = connection();
    const otherDoc = await userToken(true, 'other/doc');
    await worker.onConnect(conn, { request: new Request(roomUrl(`?token=${otherDoc}`)) });
    expect(conn.close).toHaveBeenCalled();
    expect(onConnectSpy).not.toHaveBeenCalled();
  });

  it('onBeforeConnect refuses a bad token and passes the request through otherwise', async () => {
    const lobby = { context: { party: party() } };
    const refused = await Worker.onBeforeConnect(new Request(roomUrl('?token=nope')), lobby);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);

    const token = await userToken(false);
    const request = new Request(roomUrl(`?token=${token}`));
    expect(await Worker.onBeforeConnect(request, lobby)).toBe(request);
  });
});

describe('PartyKit worker template — HTTP API', () => {
  const update = () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'injected');
    return Y.encodeStateAsUpdate(doc);
  };

  function post(token: string) {
    return new Request(roomUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: update(),
    });
  }

  it("refuses a user's token on POST, even a writer's", async () => {
    const worker = new Worker(party());
    expect((await worker.onRequest(post(await userToken(true)))).status).toBe(401);
  });

  it('refuses a user token whose userId is the server identity', async () => {
    // Signed with jwtSecret, as every browser token is — the identity alone
    // must not open the server API.
    const forged = signCollabToken({ userId: PARTYKIT_SERVER_IDENTITY, docName: DOC }, SECRET);
    const worker = new Worker(party());
    expect((await worker.onRequest(post(forged))).status).toBe(401);
  });

  it('accepts the server token the driver signs with the derived key', async () => {
    const token = signCollabToken(
      { userId: PARTYKIT_SERVER_IDENTITY, docName: DOC },
      partyKitServerKey(SECRET),
    );
    const worker = new Worker(party());
    expect((await worker.onRequest(post(token))).status).toBe(204);
  });

  it('refuses a server-key token for another identity or another room', async () => {
    const worker = new Worker(party());
    const otherUser = signCollabToken({ userId: 'u1', docName: DOC }, partyKitServerKey(SECRET));
    const otherRoom = signCollabToken(
      { userId: PARTYKIT_SERVER_IDENTITY, docName: 'other' },
      partyKitServerKey(SECRET),
    );
    expect((await worker.onRequest(post(otherUser))).status).toBe(401);
    expect((await worker.onRequest(post(otherRoom))).status).toBe(401);
  });

  it('refuses everything when COLLAB_JWT_SECRET is not set', async () => {
    const token = signCollabToken(
      { userId: PARTYKIT_SERVER_IDENTITY, docName: DOC },
      partyKitServerKey(SECRET),
    );
    const worker = new Worker(party({ COLLAB_JWT_SECRET: undefined }));
    expect((await worker.onRequest(post(token))).status).toBe(401);
  });
});

describe('PartyKit worker template — calls back to Adonis', () => {
  async function sentSecret(env: Record<string, string | undefined>) {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const worker = new Worker(party(env));
      await worker.fetchFromAdonis('/collaboration/state', {
        method: 'POST',
        body: new Uint8Array([1]),
      });
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      return (init.headers as Record<string, string>)['x-collab-worker-secret'];
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  }

  it('sends the secret derived from COLLAB_JWT_SECRET — never the JWT key', async () => {
    const sent = await sentSecret({});
    expect(sent).not.toBe(SECRET);
    expect(sent).toBe(resolvePartyKitWorkerSecret({ jwtSecret: SECRET }));
  });

  it('ignores a legacy COLLAB_WORKER_SECRET equal to the JWT key', async () => {
    expect(await sentSecret({ COLLAB_WORKER_SECRET: SECRET })).toBe(
      resolvePartyKitWorkerSecret({ jwtSecret: SECRET }),
    );
  });

  it('uses an explicit, distinct COLLAB_WORKER_SECRET', async () => {
    expect(await sentSecret({ COLLAB_WORKER_SECRET: 'explicit-worker-secret' })).toBe(
      'explicit-worker-secret',
    );
  });
});

describe('edge key derivation', () => {
  it('derives distinct keys per purpose, none equal to the JWT secret', () => {
    const worker = derivePartyKitKey(SECRET, PARTYKIT_WORKER_SECRET_LABEL);
    const server = derivePartyKitKey(SECRET, PARTYKIT_SERVER_KEY_LABEL);
    expect(new Set([SECRET, worker, server]).size).toBe(3);
    expect(derivePartyKitKey(SECRET, PARTYKIT_WORKER_SECRET_LABEL)).toBe(worker);
    expect(derivePartyKitKey('another-secret', PARTYKIT_WORKER_SECRET_LABEL)).not.toBe(worker);
  });

  it('an explicit workerSecret wins over derivation; nothing configured is undefined', () => {
    expect(resolvePartyKitWorkerSecret({ jwtSecret: SECRET, workerSecret: 'w' })).toBe('w');
    expect(resolvePartyKitWorkerSecret({})).toBeUndefined();
  });

  it('the worker template carries the same HKDF constants as the package', () => {
    expect(stubSource).toContain(`'${PARTYKIT_HKDF_SALT}'`);
    expect(stubSource).toContain(`'${PARTYKIT_WORKER_SECRET_LABEL}'`);
    expect(stubSource).toContain(`'${PARTYKIT_SERVER_KEY_LABEL}'`);
    expect(stubSource).toContain(`'${PARTYKIT_SERVER_IDENTITY}'`);
  });
});

describe('outdated worker detection', () => {
  it('the template carries the protocol marker', () => {
    expect(stubSource).toContain(PARTYKIT_WORKER_PROTOCOL_MARKER);
  });

  it('classifies a generated worker as current, outdated or missing', async () => {
    await mkdir(generatedDir, { recursive: true });
    const old = path.join(generatedDir, 'old_party.ts');
    await writeFile(old, '// an older template without the marker\n');
    expect(await partyKitWorkerStubStatus(generatedWorker)).toBe('current');
    expect(await partyKitWorkerStubStatus(old)).toBe('outdated');
    expect(await partyKitWorkerStubStatus(path.join(generatedDir, 'nope.ts'))).toBe('missing');
  });
});

/**
 * The Adonis side of the worker's calls, served by the real routes: fetch is
 * routed into `collaborationRoutes` handlers through a minimal context.
 */
function adonisBehindFetch(manager: Partial<CollabManagerLike>) {
  const handlers = new Map<string, (ctx: CollabHttpContext) => Promise<unknown>>();
  const record =
    (method: string) => (pattern: string, handler: (ctx: CollabHttpContext) => Promise<unknown>) =>
      handlers.set(`${method} /collaboration${pattern}`, handler);
  const router = {
    group(callback: () => void) {
      callback();
      return { prefix: () => ({ middleware: () => {} }) };
    },
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  };
  collaborationRoutes(router as never, {
    manager: manager as CollabManagerLike,
    partykit: { jwtSecret: SECRET },
    // No user session ever: the worker must not need one, and must not get one.
    resolveUser: async () => null,
    authorize: async () => ({ canRead: true, canWrite: true, canComment: true }),
  });

  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers as HeadersInit);
    let status = 200;
    let body: BodyInit | null = null;
    const responseHeaders: Record<string, string> = {};
    const ctx = {
      request: {
        qs: () => Object.fromEntries(url.searchParams),
        body: () => ({}),
        raw: () => (init?.body as Uint8Array | undefined) ?? null,
        header: (name: string) => headers.get(name) ?? undefined,
      },
      response: {
        status(code: number) {
          status = code;
          return {
            json(payload: unknown) {
              body = JSON.stringify(payload);
            },
          };
        },
        json(payload: unknown) {
          body = JSON.stringify(payload);
        },
        send(payload: Buffer) {
          body = new Uint8Array(payload);
        },
        noContent() {
          status = 204;
        },
        header(name: string, value: string) {
          responseHeaders[name] = value;
        },
      },
    } as unknown as CollabHttpContext;
    const handler = handlers.get(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (!handler) return new Response('not found', { status: 404 });
    await handler(ctx);
    return new Response(body, { status, headers: responseHeaders });
  });
}

describe('PartyKit worker template — loading a fresh room from Adonis', () => {
  function persisted(text: string) {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  }

  async function loadThroughWorker(manager: Partial<CollabManagerLike>, env = {}) {
    const fetchMock = adonisBehindFetch(manager);
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const worker = new Worker(party(env));
      const token = await userToken(true);
      await worker.onConnect(connection(), { request: new Request(roomUrl(`?token=${token}`)) });
      const options = onConnectSpy.mock.calls[0]![2] as { load: () => Promise<Uint8Array> };
      const state = await options.load();
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      return { text: doc.getText('t').toString(), fetchMock, error: error.mock.calls };
    } finally {
      vi.unstubAllGlobals();
      error.mockRestore();
    }
  }

  it('loads the persisted state, authenticated as the worker — no user session', async () => {
    const getStoredDocumentState = vi.fn(async () => persisted('stored text'));
    const { text, fetchMock } = await loadThroughWorker({
      getStoredDocumentState,
      // On the edge engine this would ask the worker itself; the load must
      // read storage, never the driver.
      getDocumentState: async () => {
        throw new Error('the worker load must not go through the driver');
      },
    });
    expect(text).toBe('stored text');
    expect(getStoredDocumentState).toHaveBeenCalledWith({ docName: DOC });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    // The secret itself does not travel on reads; a room-bound token does.
    expect((init.headers as Record<string, string>)['x-collab-worker-secret']).toBeUndefined();
  });

  it('starts empty, quietly, when nothing is stored yet', async () => {
    const { text, error } = await loadThroughWorker({
      getStoredDocumentState: async () => new Uint8Array(),
    });
    expect(text).toBe('');
    expect(error).toEqual([]);
  });

  it('logs the actionable reason when the secrets do not match', async () => {
    const { text, error } = await loadThroughWorker(
      { getStoredDocumentState: async () => persisted('secret stuff') },
      { COLLAB_WORKER_SECRET: 'not-what-adonis-expects' },
    );
    expect(text).toBe('');
    expect(String(error[0]?.[0])).toMatch(/403.*COLLAB_JWT_SECRET on the worker equals/);
  });
});
