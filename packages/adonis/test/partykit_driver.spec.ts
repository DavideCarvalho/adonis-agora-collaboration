import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { PartyKitDriverOptions } from '../src/driver.js';
import {
  PartyKitDriver,
  PartyKitRoomError,
  signPartyKitToken,
  verifyPartyKitToken,
} from '../src/drivers/partykit/partykit_driver.js';

const SECRET = 'test-secret-32-chars-minimum-ok!';

function makeConfig(overrides?: Partial<PartyKitDriverOptions>): PartyKitDriverOptions {
  return {
    partykit: {
      roomHost: 'localhost:1999',
      party: 'main',
      jwtSecret: SECRET,
    },
    ...overrides,
  };
}

describe('PartyKit JWT helpers', () => {
  it('signs and verifies a valid token', () => {
    const token = signPartyKitToken({ userId: 'u1', docName: 'docs/1' }, SECRET);
    const claims = verifyPartyKitToken(token, SECRET);
    expect(claims?.userId).toBe('u1');
    expect(claims?.docName).toBe('docs/1');
    expect(claims!.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = signPartyKitToken({ userId: 'u1', docName: 'docs/1' }, SECRET);
    expect(verifyPartyKitToken(token, 'wrong-secret-aaaaaaaaaaaaa')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signPartyKitToken({ userId: 'u1', docName: 'd' }, SECRET, -10);
    expect(verifyPartyKitToken(token, SECRET)).toBeNull();
  });

  it('rejects a malformed payload', () => {
    expect(verifyPartyKitToken('abc', SECRET)).toBeNull();
    expect(
      verifyPartyKitToken(`a.${Buffer.from('not-json').toString('base64url')}.c`, SECRET),
    ).toBeNull();
  });
});

describe('PartyKitDriver', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    vi.stubGlobal('fetch', fetchMock);
  }

  it('attach is a no-op that does not throw', async () => {
    const driver = new PartyKitDriver(makeConfig());
    const fakeServer = { on: vi.fn() } as unknown as import('node:http').Server;
    await expect(driver.attach(fakeServer)).resolves.toBeUndefined();
    expect(fakeServer.on).not.toHaveBeenCalled();
  });

  it('getDocumentState GETs with the update header and returns bytes', async () => {
    stubFetch();
    const state = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValue(new Response(state, { status: 200 }));

    const driver = new PartyKitDriver(makeConfig());
    const result = await driver.getDocumentState('researches/42/writing');

    expect(result).toEqual(state);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:1999/parties/main/researches%2F42%2Fwriting');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-collab-return']).toBe('update');
  });

  it('getDocumentText GETs with the text header', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response('hello world', { status: 200 }));

    const driver = new PartyKitDriver(makeConfig());
    await expect(driver.getDocumentText('doc')).resolves.toBe('hello world');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-collab-return']).toBe('text');
  });

  it('uses https for non-local hosts', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response(new Uint8Array(), { status: 200 }));

    const driver = new PartyKitDriver(
      makeConfig({ partykit: { roomHost: 'my-app.partykit.dev', jwtSecret: SECRET } }),
    );
    await driver.getDocumentState('doc');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://my-app.partykit.dev/parties/main/')).toBe(true);
  });

  it('throws PartyKitRoomError on non-2xx responses', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

    const driver = new PartyKitDriver(makeConfig());
    await expect(driver.getDocumentState('missing')).rejects.toThrowError(PartyKitRoomError);
  });

  it('createVersion fetches remote state and persists the snapshot', async () => {
    stubFetch();
    const state = new Uint8Array([9, 9, 9]);
    fetchMock.mockResolvedValue(new Response(state, { status: 200 }));
    let savedVersion: CollabVersion | undefined;
    const storage = {
      loadDocument: async () => null,
      saveDocument: async () => {},
      listVersions: async () => [],
      saveVersion: async (_doc: string, version) => {
        savedVersion = version;
      },
      loadVersionSnapshot: async () => null,
      listComments: async () => [],
      saveComment: async () => {},
      deleteComment: async () => {},
    };

    const driver = new PartyKitDriver(makeConfig({ storage }));
    const version = await driver.createVersion('doc', 'user-1', 'checkpoint');

    // Remote state fetched over HTTP exactly once.
    expect(fetchMock).toHaveBeenCalledOnce();
    // Snapshot persisted with the same returned version.
    expect(savedVersion?.id).toBe(version.id);
    expect(version.seq).toBe(1);
    expect(version.createdBy).toBe('user-1');
    expect(version.label).toBe('checkpoint');
  });

  it('restoreVersion POSTs the snapshot and saves local state', async () => {
    stubFetch();
    const snapshot = new Uint8Array([7, 7]);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const savedStates: Array<unknown> = [];
    const storage = {
      loadDocument: async () => null,
      saveDocument: async (_doc: string, state: Uint8Array) => {
        savedStates.push(state);
      },
      listVersions: async () => [
        {
          id: 'v1',
          createdAt: new Date().toISOString(),
          createdBy: null,
          label: null,
          seq: 1,
        },
      ],
      saveVersion: async () => {},
      loadVersionSnapshot: async (_doc: string, id: string) => (id === 'v1' ? snapshot : null),
      listComments: async () => [],
      saveComment: async () => {},
      deleteComment: async () => {},
    };

    const driver = new PartyKitDriver(makeConfig({ storage }));
    await driver.restoreVersion('doc', 'v1', null);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(snapshot);
    expect(savedStates.length).toBeGreaterThan(0);
    void url;
  });

  it('throws when roomHost is not configured', async () => {
    // Empty roomHost is treated as missing by the driver.
    const driver = new PartyKitDriver(
      makeConfig({ partykit: { roomHost: '', jwtSecret: SECRET } }),
    );
    await expect(driver.getDocumentState('doc')).rejects.toThrowError(/roomHost/);
  });

  it('close does not throw', async () => {
    const driver = new PartyKitDriver(makeConfig());
    await expect(driver.close()).resolves.toBeUndefined();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
