import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRE_ISSUED_TOKEN_MIN_TTL_MS,
  preIssuedTokenExpiry,
  usablePreIssuedToken,
} from '../src/pre_issued_token.js';
import { DocSession } from '../src/session.js';
import type { CollaborationClientConfig, CollabTokenInfo } from '../src/types.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

/**
 * The round-trip this removes: the client used to `GET /collaboration/token`
 * and only then open the socket, so the first byte of a document was two
 * serialized requests away — one of them to the server that had just
 * rendered the page and already knew the answer.
 *
 * What must stay true while it is gone: reconnects still fetch, because a
 * token minted at render time is precisely the one that has expired by the
 * time a socket drops, and re-fetching is what re-runs `authorize` and makes
 * revocation bite. And a bad page prop can only cost the first paint — never
 * leave the document unable to connect.
 */

const WS = { wsUrl: '/collaboration', engine: 'yjs' } as const;

function jwt(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

function makeConfig(overrides?: Partial<CollaborationClientConfig>): CollaborationClientConfig {
  return {
    baseUrl: 'https://api.app',
    fetchImpl: vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fetched', ...WS })) as typeof fetch,
    ...overrides,
  };
}

describe('usablePreIssuedToken', () => {
  const now = 1_700_000_000_000;

  it('accepts a token with life left in it', () => {
    const info = { token: 't', ...WS, expiresAt: now + 60_000 };
    expect(usablePreIssuedToken(info, now)).toBe(info);
  });

  it('accepts a token whose format reports no expiry', () => {
    // Not what this library issues any more — every token it mints carries an
    // `exp` and an `expiresAt`. A custom issuer may still report neither, and
    // "no clock to read" must not be read as "already dead": the server is
    // the one that decides, and it will.
    const info = { token: 'opaque-from-a-custom-issuer', ...WS };
    expect(usablePreIssuedToken(info, now)).toBe(info);
  });

  it('rejects an expired token, and one about to expire mid-handshake', () => {
    expect(usablePreIssuedToken({ token: 't', ...WS, expiresAt: now - 1 }, now)).toBeUndefined();
    // There is a socket to open between this check and the server reading the
    // token; a credential with a blink left just costs a round-trip.
    expect(
      usablePreIssuedToken(
        { token: 't', ...WS, expiresAt: now + PRE_ISSUED_TOKEN_MIN_TTL_MS },
        now,
      ),
    ).toBeUndefined();
  });

  it('reads the exp of an edge JWT when the server reported no expiresAt', () => {
    const dead = { token: jwt({ exp: Math.floor(now / 1000) - 10 }), ...WS };
    const alive = { token: jwt({ exp: Math.floor(now / 1000) + 600 }), ...WS };

    expect(preIssuedTokenExpiry(dead)).toBe((Math.floor(now / 1000) - 10) * 1000);
    expect(usablePreIssuedToken(dead, now)).toBeUndefined();
    expect(usablePreIssuedToken(alive, now)).toBe(alive);
  });

  it('rejects anything a transport could not be built from', () => {
    expect(usablePreIssuedToken(undefined, now)).toBeUndefined();
    expect(usablePreIssuedToken(null, now)).toBeUndefined();
    expect(usablePreIssuedToken({ token: '', ...WS }, now)).toBeUndefined();
    // engine and wsUrl are not decoration — without them there is nothing to
    // build, and a half-token is a crash, not a shortcut.
    expect(usablePreIssuedToken({ token: 't', wsUrl: '', engine: 'yjs' }, now)).toBeUndefined();
    expect(usablePreIssuedToken({ token: 't', wsUrl: '/x', engine: '' }, now)).toBeUndefined();
    expect(
      usablePreIssuedToken({ token: 'a.b.c', ...WS } as CollabTokenInfo, now),
    ).not.toBeUndefined(); // unreadable payload → no expiry known, still usable
  });
});

describe('DocSession with a pre-issued token', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the socket without touching the token endpoint', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi.fn();
    const session = new DocSession(
      'docs/1',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
      { initialToken: { token: 'pre-issued', ...WS } },
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(created[0]!.info.token).toBe('pre-issued');
    expect(session.engine).toBe('yjs');

    session.destroy();
  });

  it('reads the token from the provider config, keyed by docName', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi.fn();
    const session = new DocSession(
      'docs/2',
      makeConfig({
        createTransport: factory,
        fetchImpl: fetchMock as unknown as typeof fetch,
        initialTokens: { 'docs/2': { token: 'from-config', ...WS } },
      }),
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(created[0]!.info.token).toBe('from-config');
    expect(fetchMock).not.toHaveBeenCalled();
    session.destroy();
  });

  it('ignores a token issued for another document', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fetched', ...WS }));
    const session = new DocSession(
      'docs/3',
      makeConfig({
        createTransport: factory,
        fetchImpl: fetchMock as unknown as typeof fetch,
        initialTokens: { 'docs/other': { token: 'not-mine', ...WS } },
      }),
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created[0]!.info.token).toBe('fetched');
    session.destroy();
  });

  it('keeps the HTTP flow untouched when no token is supplied', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fetched', ...WS }));
    const session = new DocSession(
      'docs/4',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created[0]!.info.token).toBe('fetched');
    session.destroy();
  });

  it('falls back to the endpoint when the pre-issued token is already dead', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fetched', ...WS }));
    const session = new DocSession(
      'docs/5',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
      { initialToken: { token: 'stale', ...WS, expiresAt: Date.now() - 1_000 } },
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // A page prop that sat in a sleeping tab must not strand the document.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.info.token).toBe('fetched');
    expect(session.getStatus()).not.toBe('error');

    session.destroy();
  });

  it('falls back to the endpoint when the pre-issued token is malformed', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fetched', ...WS }));
    const session = new DocSession(
      'docs/6',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
      { initialToken: { token: 'no-engine', wsUrl: '', engine: '' } },
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created[0]!.info.token).toBe('fetched');
    session.destroy();
  });

  it('fetches a fresh token on reconnect — the pre-issued one is used once', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fresh', ...WS }));
    const session = new DocSession(
      'docs/7',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
      { initialToken: { token: 'pre-issued', ...WS, expiresAt: Date.now() + 300_000 } },
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();

    created[0]!.setStatus('connected');
    created[0]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1100);

    // Reconnecting is exactly when the render-time token has died — and
    // re-fetching is what re-runs authorize, so revocation takes effect.
    expect(created).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created[1]!.info.token).toBe('fresh');

    created[1]!.setStatus('disconnected');
    // Backoff doubled: transport #2 never reached 'connected'.
    await vi.advanceTimersByTimeAsync(2100);
    expect(created[2]!.info.token).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    session.destroy();
  });

  it('does not reuse the pre-issued token after stop()/start()', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ token: 'fresh', ...WS }));
    const session = new DocSession(
      'docs/8',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as unknown as typeof fetch }),
      { initialToken: { token: 'pre-issued', ...WS } },
    );

    const release = session.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(created[0]!.info.token).toBe('pre-issued');

    release();
    session.retain();
    await vi.advanceTimersByTimeAsync(0);

    expect(created[1]!.info.token).toBe('fresh');
    session.destroy();
  });
});
