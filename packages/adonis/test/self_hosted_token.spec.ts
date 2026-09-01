import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CollabTokenSecretMissingError } from '../src/auth/secret.js';
import { issueToken, signCollabToken, verifyCollabToken } from '../src/auth/token.js';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { AutomergeDriver } from '../src/drivers/automerge/automerge_driver.js';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import type { PresenceMember } from '../src/services/presence_service.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabConnectionContext, CollabPermission } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * The self-hosted token used to be an unsigned claim, and the handshake
 * believed it.
 *
 * `issueToken` returned `base64(JSON.stringify({ userId }))` and the drivers
 * accepted anything that decoded to an object with a `userId` in it. So a
 * client with **no session, no cookie and no login** could connect with
 * `base64({"userId":"<someone else's id>"})`, be authorized as that person by
 * the app's own `authorize` rule, and write into their document. The token
 * never expired and there was no way to revoke one.
 *
 * Everything below fails against that version of the code. What replaced it
 * is an HS256 JWT signed with the app's key, carrying the document it was
 * issued for and a five-minute expiry — checked in that order, by both
 * self-hosted drivers, before `authorize` is consulted at all.
 */

const DOC = 'researches/42/writing';
const OTHER_DOC = 'researches/43/writing';
const allow = async (): Promise<CollabPermission> => ({
  canRead: true,
  canWrite: true,
  canComment: true,
});

/** The forgery that used to work. */
function forgedToken(userId: string): string {
  return Buffer.from(JSON.stringify({ userId })).toString('base64');
}

interface Hooks {
  onAuthenticate(payload: {
    documentName: string;
    token: string;
    socketId?: string;
    connectionConfig: { readOnly: boolean };
  }): Promise<unknown>;
}

function hooksOf(driver: YjsDriver): Hooks {
  return (driver as unknown as { hocuspocus: { configuration: Hooks } }).hocuspocus.configuration;
}

function authenticate(driver: YjsDriver, token: string, documentName = DOC): Promise<unknown> {
  return hooksOf(driver).onAuthenticate({
    documentName,
    token,
    socketId: 'socket-1',
    connectionConfig: { readOnly: false },
  });
}

const teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

function yjsDriver(options: { authorize?: typeof allow; tokenSecret?: string } = {}): YjsDriver {
  const driver = new YjsDriver({
    authorize: options.authorize ?? allow,
    ...(options.tokenSecret === undefined ? {} : { tokenSecret: options.tokenSecret }),
    storage: new InMemoryCollaborationStorage(),
    path: '/collab',
    // The cast is the point of one of the tests below: `tokenSecret` is a
    // required option precisely so this is hard to do by accident, and the
    // misconfiguration still has to fail closed at runtime for anyone who
    // reaches it from JavaScript.
  } as ConstructorParameters<typeof YjsDriver>[0]);
  teardown.push(() => driver.close());
  return driver;
}

/** A listening HTTP server with the driver's upgrade handler mounted. */
async function serve(driver: { attach(server: import('node:http').Server): Promise<void> }) {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await driver.attach(server);
  return (server.address() as AddressInfo).port;
}

describe('the self-hosted handshake only accepts a token this server signed', () => {
  it('refuses a forged identity — the whole vulnerability, in one assertion', async () => {
    const authorize = vi.fn(allow);
    const driver = yjsDriver({ authorize, tokenSecret: TEST_TOKEN_SECRET });

    await expect(authenticate(driver, forgedToken('u_victim'))).rejects.toThrow(/invalid token/);
    // Not merely denied: the rule is never even asked, because there is no
    // caller to ask about.
    expect(authorize).not.toHaveBeenCalled();
  });

  it('refuses a token whose signature was altered', async () => {
    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });
    const [header, body] = testToken(DOC, 'u_1').split('.');

    // Same claims, a signature that is not ours.
    const tampered = `${header}.${body}.${Buffer.from('nope').toString('base64url')}`;
    await expect(authenticate(driver, tampered)).rejects.toThrow(/invalid token/);

    // And the claims themselves cannot be edited under our signature: bumping
    // the userId invalidates the very signature that vouches for it.
    const forgedBody = Buffer.from(
      JSON.stringify({ userId: 'u_someone_else', docName: DOC, exp: 2 ** 32 }),
    ).toString('base64url');
    const signature = testToken(DOC, 'u_1').split('.')[2];
    await expect(authenticate(driver, `${header}.${forgedBody}.${signature}`)).rejects.toThrow(
      /invalid token/,
    );
  });

  it('refuses a token signed with somebody else’s key', async () => {
    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });
    const elsewhere = signCollabToken({ userId: 'u_1', docName: DOC }, 'another-apps-secret-key!!');

    await expect(authenticate(driver, elsewhere)).rejects.toThrow(/invalid token/);
  });

  it('refuses a valid token issued for a different document', async () => {
    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });

    // The caller may genuinely read OTHER_DOC — this token is really theirs.
    // Without the binding, "may read one document" would be "may read every
    // document", since the client picks the name it connects to.
    await expect(authenticate(driver, testToken(OTHER_DOC, 'u_1'), DOC)).rejects.toThrow(
      /invalid token/,
    );
    await expect(
      authenticate(driver, testToken(OTHER_DOC, 'u_1'), OTHER_DOC),
    ).resolves.toBeTruthy();
  });

  it('refuses an expired token', async () => {
    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });
    const dead = testToken(DOC, 'u_1', { expiresInSeconds: -1 });

    await expect(authenticate(driver, dead)).rejects.toThrow(/invalid token/);
  });

  it('refuses a signed token that carries no expiry', async () => {
    // Reaching this needs the signing key, so it is not an outsider's path.
    // It is here because `parsed.exp * 1000` is NaN without an `exp` and
    // `NaN < Date.now()` is false: the token read as "not expired" and lived
    // forever, which is the one property the signed format exists to remove.
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      userId: 'u_1',
      docName: DOC,
    })}`;
    const forever = `${unsigned}.${createHmac('sha256', TEST_TOKEN_SECRET)
      .update(unsigned)
      .digest('base64url')}`;

    expect(verifyCollabToken(forever, TEST_TOKEN_SECRET, DOC)).toBeNull();

    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });
    await expect(authenticate(driver, forever)).rejects.toThrow(/invalid token/);
  });

  it('accepts a live token and hands `authorize` the id the signature vouches for', async () => {
    const seen: Array<{ ctx: CollabConnectionContext; docName: string }> = [];
    const driver = yjsDriver({
      authorize: async (ctx, docName) => {
        seen.push({ ctx, docName });
        return allow();
      },
      tokenSecret: TEST_TOKEN_SECRET,
    });

    const connectionConfig = { readOnly: false };
    await hooksOf(driver).onAuthenticate({
      documentName: DOC,
      token: testToken(DOC, 'u_1', { name: 'Jane' }),
      connectionConfig,
    });

    expect(seen).toEqual([{ ctx: { userId: 'u_1', user: { name: 'Jane' } }, docName: DOC }]);
    expect(connectionConfig.readOnly).toBe(false);
  });

  it('publishes the verified identity as the connection context', async () => {
    const driver = yjsDriver({ tokenSecret: TEST_TOKEN_SECRET });

    // Everything downstream (presence, above all) reads this instead of
    // decoding the wire a second time — an unauthenticated second decode is
    // how a forged name reached the roster even with a checked handshake.
    await expect(authenticate(driver, testToken(DOC, 'u_1', { name: 'Jane' }))).resolves.toEqual({
      collab: { userId: 'u_1', user: { name: 'Jane' } },
    });
  });
});

describe('no signing key configured', () => {
  it('refuses to issue, naming what to set', async () => {
    // Nothing explicit, and no AdonisJS app in this process to read an appKey
    // from: there is no key, so there is no token.
    await expect(
      issueToken({ engine: 'yjs', path: '/collaboration' }, { id: 'u_1' }, DOC, allow),
    ).rejects.toBeInstanceOf(CollabTokenSecretMissingError);

    await expect(issueToken({ engine: 'yjs' }, { id: 'u_1' }, DOC, allow)).rejects.toThrow(
      /tokenSecret|APP_KEY/,
    );
  });

  it('refuses to verify, instead of falling back to the format it replaced', async () => {
    const authorize = vi.fn(allow);
    const driver = yjsDriver({ authorize });

    // Both a forged token and a well-formed one are refused: with no key,
    // nothing can be verified, and "cannot verify" is never "let them in".
    await expect(authenticate(driver, forgedToken('u_victim'))).rejects.toBeInstanceOf(
      CollabTokenSecretMissingError,
    );
    await expect(authenticate(driver, testToken(DOC, 'u_1'))).rejects.toBeInstanceOf(
      CollabTokenSecretMissingError,
    );
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('the manager is the single source of the key', () => {
  it('signs with the key its own drivers verify against', async () => {
    const manager = new CollaborationManager({
      engine: 'yjs',
      tokenSecret: TEST_TOKEN_SECRET,
      authorize: allow,
      storage: new InMemoryCollaborationStorage(),
    });
    teardown.push(() => manager.close());

    // The route asks the manager for the key; the driver is handed the same
    // accessor. A token minted from one has to open the other, or the app
    // works in tests and refuses every handshake in production.
    const issued = await issueToken(
      { engine: 'yjs', tokenSecret: await manager.tokenSecret() },
      { id: 'u_1' },
      DOC,
      allow,
    );

    const driver = (manager as unknown as { drivers: Map<string, YjsDriver> }).drivers.get('yjs')!;
    await expect(authenticate(driver, issued.token)).resolves.toBeTruthy();
  });
});

describe('the automerge upgrade path checks the same three things', () => {
  /** Opens a socket and resolves with how the server closed it, if it did. */
  function connect(port: number, query: string) {
    return new Promise<{ code: number; reason: string } | 'open'>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/collab?${query}`);
      const timer = setTimeout(() => reject(new Error('the server never answered')), 4000);
      // The driver sends the room state as the first message on success.
      socket.on('message', () => {
        clearTimeout(timer);
        socket.close();
        resolve('open');
      });
      socket.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      socket.on('error', () => {});
    });
  }

  it('closes the socket on a forged, a foreign-document and an expired token', async () => {
    const authorize = vi.fn(allow);
    const driver = new AutomergeDriver({
      authorize,
      tokenSecret: TEST_TOKEN_SECRET,
      storage: new InMemoryCollaborationStorage(),
      path: '/collab',
    });
    teardown.push(() => driver.close());
    const port = await serve(driver);
    const doc = `doc=${encodeURIComponent(DOC)}`;

    expect(await connect(port, `${doc}&token=${forgedToken('u_victim')}`)).toMatchObject({
      code: 4001,
    });
    expect(
      await connect(port, `${doc}&token=${encodeURIComponent(testToken(OTHER_DOC, 'u_1'))}`),
    ).toMatchObject({ code: 4001 });
    expect(
      await connect(
        port,
        `${doc}&token=${encodeURIComponent(testToken(DOC, 'u_1', { expiresInSeconds: -1 }))}`,
      ),
    ).toMatchObject({ code: 4001 });

    // None of the three got as far as the permission rule.
    expect(authorize).not.toHaveBeenCalled();

    // And the real credential opens the room.
    expect(await connect(port, `${doc}&token=${encodeURIComponent(testToken(DOC, 'u_1'))}`)).toBe(
      'open',
    );
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]![0]).toMatchObject({ userId: 'u_1' });
  });
});

describe('over a real WebSocket, end to end', () => {
  /** Connects a HocuspocusProvider and reports which way the handshake went. */
  function handshake(port: number, token: string, docName = DOC) {
    return new Promise<'synced' | { denied: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server never answered')), 4000);
      const provider: HocuspocusProvider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: docName,
        token,
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          void provider.destroy();
          resolve('synced');
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          void provider.destroy();
          resolve({ denied: reason });
        },
      });
      teardown.push(() => provider.destroy());
    });
  }

  it('turns away a browser carrying a forged token, and lets a real one in', async () => {
    const authorize = vi.fn(allow);
    const driver = yjsDriver({ authorize, tokenSecret: TEST_TOKEN_SECRET });
    const port = await serve(driver);

    // The proof-of-concept, verbatim: no session, no cookie, no login — just
    // the victim's id in a base64 blob. It used to sync and let the client
    // write; now the socket is told no.
    expect(await handshake(port, forgedToken('u_victim'))).toMatchObject({
      denied: 'permission-denied',
    });
    expect(authorize).not.toHaveBeenCalled();

    // A token this server issued for this document syncs, as it always did.
    expect(await handshake(port, testToken(DOC, 'u_1'))).toBe('synced');
    expect(authorize.mock.calls[0]![0]).toMatchObject({ userId: 'u_1' });
  });

  it('puts the verified user on the presence roster', async () => {
    const roster = new Map<string, PresenceMember>();
    const manager = new CollaborationManager(
      {
        engine: 'yjs',
        tokenSecret: TEST_TOKEN_SECRET,
        authorize: allow,
        storage: new InMemoryCollaborationStorage(),
        path: '/collab',
      },
      {
        async join(_docName, member) {
          roster.set(member.userId, member);
        },
        async leave(_docName, userId) {
          roster.delete(userId);
        },
        async list() {
          return [...roster.values()];
        },
        async close() {},
      },
    );
    teardown.push(() => manager.close());
    const port = await serve(manager);

    expect(await handshake(port, testToken(DOC, 'u_1', { name: 'Jane' }))).toBe('synced');
    await expect
      .poll(() => manager.listPresence({ docName: DOC }))
      .toEqual([{ userId: 'u_1', name: 'Jane' }]);

    // Worth an end-to-end test rather than a hook call: the roster used to be
    // filled from `onConnect` reading `?token=` off the query string, and the
    // real client sends the token in the Auth *message*. So over an actual
    // socket that path found no token and the store stayed empty — presence
    // was both forgeable and, with the shipped transport, never populated.
  });
});
