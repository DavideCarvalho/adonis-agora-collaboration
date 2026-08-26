import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollabRestError,
  createComment,
  createVersion,
  fetchToken,
  listComments,
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
      userId: 'u1',
      authorName: null,
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

  it('createVersion envia docName + label no body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: 'v1', createdAt: '', createdBy: null, label: null, seq: 1 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createVersion(config, 'doc', 'antes da revisão', 'u1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.app/collaboration/versions');
    expect(JSON.parse(init.body as string)).toEqual({
      docName: 'doc',
      label: 'antes da revisão',
      userId: 'u1',
    });
  });
});
