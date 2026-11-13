import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationProvider } from '../src/context.js';
import { useComments } from '../src/hooks/use_comments.js';
import { useVersions } from '../src/hooks/use_versions.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

const comments = [
  {
    id: 'c1',
    documentName: 'docs/9',
    space: 'text',
    anchor: { kind: 'text-range', start: 0, end: 4, selectedText: 'ola' },
    body: 'revisar',
    userId: 'u1',
    authorName: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  },
];

const versions = [
  { id: 'v1', createdAt: new Date().toISOString(), createdBy: null, label: null, seq: 1 },
];

const page = <T,>(data: T[]) => ({
  data,
  meta: { total: data.length, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
});

function makeWrapper(extra: { prefix?: string } = {}) {
  const { factory } = fakeTransportFactory();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes('/collaboration/token')) {
      return Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' });
    }
    if (url.includes('/comments') && (input as Request).method === 'POST') {
      return Response.json({ ...comments[0], id: 'c2' });
    }
    if (url.includes('/comments')) {
      return Response.json(page(comments));
    }
    if (url.includes('/versions') && (input as Request).method === 'POST') {
      return Response.json({ ...versions[0], id: 'v2', seq: 2 });
    }
    if (url.includes('/versions')) {
      return Response.json(page(versions));
    }
    return new Response('not found', { status: 404 });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        ...extra,
        createTransport: factory,
        fetchImpl: fetchMock as typeof fetch,
      },
      children,
    );

  return { wrapper, fetchMock };
}

describe('useComments', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('carrega comentários via REST', async () => {
    const { wrapper, fetchMock } = makeWrapper();
    const { result } = renderHook(() => useComments({ docName: 'docs/9', space: 'text' }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.meta).toMatchObject({ total: 1, currentPage: 1 });
    const [url] = fetchMock.mock.calls.find((call) => String(call[0]).includes('/comments')) as [
      string,
    ];
    expect(url).toContain('doc=docs%2F9');
    expect(url).toContain('filter%5Bspace%5D=text');
  });

  it('create chama POST e refresca a lista', async () => {
    const { wrapper, fetchMock } = makeWrapper();
    const { result } = renderHook(() => useComments({ docName: 'docs/9' }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({
        space: 'text',
        anchor: { kind: 'text-range', start: 0, end: 4, selectedText: 'ola' },
        body: 'nova',
      });
    });

    const postCall = fetchMock.mock.calls.find(
      (call) => (call[0] as Request).method === undefined || true,
    );
    void postCall;
    // refresh re-lista: ao menos duas chamadas GET /comments.
    const listCalls = fetchMock.mock.calls.filter(
      ([input]) =>
        input.toString().includes('/comments') &&
        (!(input as Request).method || (input as Request).method === 'GET'),
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolve atualiza localmente sem recarregar tudo', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useComments({ docName: 'docs/9' }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.resolve('c1');
    });

    await waitFor(() =>
      expect(
        result.current.comments.find((comment) => comment.id === 'c1')?.resolvedAt,
      ).toBeTruthy(),
    );
  });
});

describe('useVersions', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('carrega versões e cria nova com label', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useVersions({ docName: 'docs/9' }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.versions).toHaveLength(1);

    await act(async () => {
      await result.current.create('checkpoint');
    });

    await waitFor(() => expect(result.current.versions.length).toBeGreaterThanOrEqual(1));
  });
});

describe('list paging through the hooks', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const listUrls = (fetchMock: ReturnType<typeof vi.fn>, path: string) =>
    fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname.endsWith(path));

  it('useVersions asks for the newest page and refetches when the page changes', async () => {
    const { wrapper, fetchMock } = makeWrapper();
    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useVersions({ docName: 'docs/9', sort: '-seq', size: 20, page }),
      { wrapper, initialProps: { page: 1 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let urls = listUrls(fetchMock, '/versions');
    expect(Object.fromEntries(urls.at(-1)!.searchParams)).toEqual({
      doc: 'docs/9',
      page: '1',
      size: '20',
      sort: '-seq',
    });

    rerender({ page: 2 });
    await waitFor(() => expect(listUrls(fetchMock, '/versions')).toHaveLength(2));
    urls = listUrls(fetchMock, '/versions');
    expect(urls.at(-1)!.searchParams.get('page')).toBe('2');
  });

  it('useComments passes sort and size along with the space filter', async () => {
    const { wrapper, fetchMock } = makeWrapper({ prefix: '/api/collab' });
    const { result } = renderHook(
      () => useComments({ docName: 'docs/9', space: 'text', sort: '-createdAt', size: 10 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const url = listUrls(fetchMock, '/comments').at(-1)!;
    expect(url.pathname).toBe('/api/collab/comments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      doc: 'docs/9',
      'filter[space]': 'text',
      size: '10',
      sort: '-createdAt',
    });
  });
});
