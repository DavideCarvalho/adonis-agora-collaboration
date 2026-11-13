import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollabRestError,
  createComment,
  createVersion,
  fetchToken,
  listComments,
  listVersions,
  resolveBaseUrl,
} from '../src/rest_client.js';
import type { CollaborationClientConfig } from '../src/types.js';

const config: CollaborationClientConfig = { baseUrl: 'https://api.app' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rest_client', () => {
  it('fetchToken monta URL com query param doc', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await fetchToken(config, 'researches/42/writing');
    expect(info.engine).toBe('yjs');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.app/collaboration/token?doc=researches%2F42%2Fwriting');
    expect(init.method).toBe('GET');
  });

  it('anexa headers de getHeaders e content-type no POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'c1' }));
    vi.stubGlobal('fetch', fetchMock);
    const cfg: CollaborationClientConfig = {
      baseUrl: 'https://api.app/',
      getHeaders: () => ({ cookie: 'session=abc' }),
    };

    await createComment(cfg, {
      documentName: 'd',
      space: 'text',
      anchor: { kind: 'text-range', start: 0, end: 1, selectedText: 'a' },
      body: 'nota',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('session=abc');
    expect(headers['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('lança CollabRestError em resposta não-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));

    await expect(listComments(config, 'd')).rejects.toThrowError(CollabRestError);
  });

  it('createVersion envia docName + label no body, e nada de userId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: 'v1', createdAt: '', createdBy: null, label: null, seq: 1 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createVersion(config, 'doc', 'antes da revisão');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.app/collaboration/versions');
    // The author is the authenticated caller — the route reads the session and
    // ignores the body, so nothing about an author goes on the wire.
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ docName: 'doc', label: 'antes da revisão' });
    expect(Object.keys(body)).toEqual(['docName', 'label']);
  });
});

const emptyPage = {
  data: [],
  meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
};

describe('rest_client paging and prefix', () => {
  const lastUrl = (fetchMock: ReturnType<typeof vi.fn>) =>
    new URL((fetchMock.mock.calls.at(-1) as [string])[0]);

  it('sends filter[space], sort, page and size on the list calls, and nothing it was not given', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(emptyPage));
    vi.stubGlobal('fetch', fetchMock);

    await listVersions(config, 'd/1', { page: 2, size: 25, sort: '-seq' });
    expect(Object.fromEntries(lastUrl(fetchMock).searchParams)).toEqual({
      doc: 'd/1',
      page: '2',
      size: '25',
      sort: '-seq',
    });

    await listComments(config, 'd/1', { space: 'text', sort: '-createdAt' });
    expect(Object.fromEntries(lastUrl(fetchMock).searchParams)).toEqual({
      doc: 'd/1',
      'filter[space]': 'text',
      sort: '-createdAt',
    });

    await listComments(config, 'd/1', { sort: 'createdAt', page: 3 });
    expect(Object.fromEntries(lastUrl(fetchMock).searchParams)).toEqual({
      doc: 'd/1',
      sort: 'createdAt',
      page: '3',
    });

    await listVersions(config, 'd/1');
    expect(Object.fromEntries(lastUrl(fetchMock).searchParams)).toEqual({ doc: 'd/1' });
  });

  it('returns the { data, meta } page as the server sent it', async () => {
    const page = {
      data: [{ id: 'v1', createdAt: '', createdBy: null, label: null, seq: 1 }],
      meta: { total: 51, perPage: 50, currentPage: 2, lastPage: 2, firstPage: 1 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(page)));

    await expect(listVersions(config, 'd/1', { page: 2 })).resolves.toEqual(page);
  });

  it('mounts every route under config.prefix', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(emptyPage));
    vi.stubGlobal('fetch', fetchMock);

    await listVersions({ ...config, prefix: '/api/collab/' }, 'd/1');
    expect(lastUrl(fetchMock).pathname).toBe('/api/collab/versions');

    await fetchToken({ ...config, prefix: 'api/collab' }, 'd/1');
    expect(lastUrl(fetchMock).pathname).toBe('/api/collab/token');

    await listComments({ ...config, prefix: '' }, 'd/1');
    expect(lastUrl(fetchMock).pathname).toBe('/comments');

    await listComments(config, 'd/1');
    expect(lastUrl(fetchMock).pathname).toBe('/collaboration/comments');
  });
});

describe('resolveBaseUrl (same-origin default)', () => {
  it('uses explicit baseUrl when provided', () => {
    expect(resolveBaseUrl({ baseUrl: 'https://api.app/' })).toBe('https://api.app');
  });

  /**
   * `baseUrl` was declared required on `CollaborationClientConfig` while
   * `resolveBaseUrl` had always fallen back to `location.origin` — so the
   * same-origin setup the docs advertise ("pass it and forget it") did not
   * typecheck and had to be worked around with a cast.
   */
  it('a config with no baseUrl is valid and resolves against location.origin', async () => {
    const original = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://app.example' },
      configurable: true,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }));
    const sameOrigin: CollaborationClientConfig = { fetchImpl: fetchMock as typeof fetch };

    await fetchToken(sameOrigin, 'docs/1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://app.example/collaboration/token?doc=docs%2F1',
    );

    Object.defineProperty(globalThis, 'location', { value: original, configurable: true });
  });

  it('falls back to the current origin when omitted', () => {
    const original = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://app.example' },
      configurable: true,
    });
    expect(resolveBaseUrl({})).toBe('https://app.example');
    Object.defineProperty(globalThis, 'location', {
      value: original,
      configurable: true,
    });
  });
});
