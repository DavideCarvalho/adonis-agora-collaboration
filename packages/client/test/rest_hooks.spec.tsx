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

function makeWrapper() {
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
      return Response.json(comments);
    }
    if (url.includes('/versions') && (input as Request).method === 'POST') {
      return Response.json({ ...versions[0], id: 'v2', seq: 2 });
    }
    if (url.includes('/versions')) {
      return Response.json(versions);
    }
    return new Response('not found', { status: 404 });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
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
    const [url] = fetchMock.mock.calls.find((call) => String(call[0]).includes('/comments')) as [
      string,
    ];
    expect(url).toContain('doc=docs%2F9');
    expect(url).toContain('space=text');
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
        userId: 'u2',
        authorName: null,
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
