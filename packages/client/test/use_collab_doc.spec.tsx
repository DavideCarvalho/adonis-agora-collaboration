import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationProvider } from '../src/context.js';
import { useAwareness } from '../src/hooks/use_awareness.js';
import { useCollabDoc } from '../src/hooks/use_collab_doc.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useCollabDoc', () => {
  it('conecta com transporte injetado e reflete status inicial', async () => {
    const { factory } = fakeTransportFactory();

    const { result } = renderHookProbe(['docs/1'], {
      baseUrl: 'https://api.app',
      createTransport: factory,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' })),
    });

    await waitFor(() => {
      expect(result.current[0]?.status).toBeDefined();
    });
    expect(result.current[0]?.doc).toBeTruthy();
  });

  it('reutiliza a mesma sessão/Y.Doc para o mesmo docName no mesmo provider', async () => {
    const { factory } = fakeTransportFactory();

    const { result } = renderHookProbe(['docs/2', 'docs/2'], {
      baseUrl: 'https://api.app',
      createTransport: factory,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' })),
    });

    await waitFor(() => expect(result.current[0]?.status).toBeDefined());
    const [first] = result.current;
    const [, second] = result.current;
    // Mesmo docName → mesmo Y.Doc cacheado; token buscado uma única vez.
    expect(second?.doc).toBe(first?.doc);
  });

  it('docNames diferentes criam Y.Docs diferentes', async () => {
    const { factory } = fakeTransportFactory();

    const { result } = renderHookProbe(['docs/a', 'docs/b'], {
      baseUrl: 'https://api.app',
      createTransport: factory,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' })),
    });

    await waitFor(() => expect(result.current[0]?.status).toBeDefined());
    const [a, b] = result.current;
    expect(a?.doc).not.toBe(b?.doc);
  });

  it('marca erro quando o endpoint de token falha', async () => {
    const { result } = renderHookProbe(['docs/3'], {
      baseUrl: 'https://api.app',
      fetchImpl: vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    });

    await waitFor(() => expect(result.current[0]?.status).toBe('error'));
    expect(result.current[0]?.error?.message).toContain('401');
  });

  it('useAwareness expõe peers vazios sem awareness ativa', async () => {
    const { factory } = fakeTransportFactory();
    let awarenessResult: { peers: unknown[]; status: string } | undefined;

    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }));

    function Probe() {
      useCollabDoc({ docName: 'docs/4' });
      awarenessResult = useAwareness({ docName: 'docs/4' });
      return null;
    }

    await act(async () => {
      render(
        createElement(
          CollaborationProvider,
          { baseUrl: 'https://api.app', createTransport: factory, fetchImpl: fetchMock },
          createElement(Probe),
        ),
      );
    });

    await waitFor(() => expect(awarenessResult?.status).toBeDefined());
    expect(Array.isArray(awarenessResult?.peers)).toBe(true);
    expect(awarenessResult?.peers).toHaveLength(0);
  });
});

/* ── helpers ─────────────────────────────────────────────────────────── */

type ProviderProps = Parameters<typeof CollaborationProvider>[0];
type DocResult = ReturnType<typeof useCollabDoc>;

/**
 * Monta um único provider com N probes do useCollabDoc — permite comparar
 * sessões dentro da mesma árvore de contexto.
 */
function renderHookProbe(docNames: string[], props: Omit<ProviderProps, 'children'>) {
  const results: DocResult[] = [];

  function Probe({ index, docName }: { index: number; docName: string }) {
    results[index] = useCollabDoc({ docName });
    return null;
  }

  const rendered = render(
    createElement(
      CollaborationProvider,
      props as ProviderProps,
      ...docNames.map((docName, index) =>
        createElement(Probe, { key: docName + index, index, docName }),
      ),
    ),
  );

  return {
    result: {
      get current() {
        return results;
      },
    },
    rendered,
  };
}
