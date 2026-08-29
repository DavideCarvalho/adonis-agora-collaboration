import * as A from '@automerge/automerge';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaborationProvider } from '../src/context.js';
import { useAutomergeDoc } from '../src/hooks/use_automerge_doc.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

/** Minimal fake WebSocket capturing instances + simulating the server. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  sent: ArrayBuffer[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.buffer });
  }
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  close(code?: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function wrapper(fetchImpl?: typeof fetch) {
  const { factory } = fakeTransportFactory();
  return ({ children }: { children: React.ReactNode }) =>
    createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        createTransport: factory,
        fetchImpl:
          fetchImpl ??
          ((async (input: string | URL | Request) => {
            if (input.toString().includes('/collaboration/token')) {
              return Response.json({ token: 't', wsUrl: '/collaboration', engine: 'automerge' });
            }
            return new Response('not found', { status: 404 });
          }) as typeof fetch),
      },
      children,
    );
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAutomergeDoc', () => {
  it('merges the initial server payload and exposes the doc', async () => {
    const initial = A.from<Record<string, unknown>>({ content: 'hello' });
    const { result } = renderHook(
      () =>
        useAutomergeDoc({
          docName: 'd/1',
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        }),
      { wrapper: wrapper() },
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain('/collaboration?doc=d%2F1&token=t');

    act(() => {
      ws.open();
      ws.serverSend(A.save(initial));
    });

    await waitFor(() => expect(result.current.doc).not.toBeNull());
    expect((result.current.doc as { content?: string }).content).toBe('hello');
    expect(result.current.status).toBe('connected');
  });

  it('change() mutates locally and sends the saved doc after debounce', async () => {
    const initial = A.from<Record<string, unknown>>({ content: '' });
    const { result } = renderHook(
      () =>
        useAutomergeDoc({
          docName: 'd/2',
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        }),
      { wrapper: wrapper() },
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.serverSend(A.save(initial));
    });
    await waitFor(() => expect(result.current.doc).not.toBeNull());

    act(() => {
      result.current.change((d) => {
        (d as { content: string }).content = 'edited';
      });
    });
    expect((result.current.doc as { content?: string }).content).toBe('edited');

    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(ws.sent).toHaveLength(1);
    const roundtrip = A.load<{ content?: string }>(new Uint8Array(ws.sent[0]!));
    expect(roundtrip.content).toBe('edited');
  });

  it('converges concurrent list edits from both sides', async () => {
    // Both clients fork from the SAME base state — real concurrent scenario.
    const base = A.from<Record<string, unknown>>({ items: [] as unknown[] });
    const baseSaved = A.save(base);

    const { result } = renderHook(
      () =>
        useAutomergeDoc({
          docName: 'd/3',
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        }),
      { wrapper: wrapper() },
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.serverSend(
        A.save(
          A.change(A.load(baseSaved), (d) => {
            (d as { items: string[] }).items.push('server-seeded');
          }),
        ),
      );
    });
    await waitFor(() => expect(result.current.doc).not.toBeNull());

    // Second client, same base lineage, distinct actor.
    const remoteFork = A.load(baseSaved);
    const remote = A.change(remoteFork, { actor: 'actor-remote' } as never, (d) => {
      (d as { items: string[] }).items.push('remote');
    });

    // Local side adds its own entry.
    act(() => {
      result.current.change((d) => {
        (d as { items: string[] }).items.push('local');
      });
    });
    act(() => {
      ws.serverSend(A.save(remote));
    });

    const items = (result.current.doc as { items?: string[] }).items ?? [];
    expect(items).toContain('server-seeded');
    expect(items).toContain('remote');
    expect(items).toContain('local');
  });
});

/**
 * The hook used to open ONE socket: `ws.onclose` set `'disconnected'` and nothing
 * ever rebuilt it, while `change()` went on mutating the local doc — a user typing
 * into a document that had stopped syncing, with no state saying so. These cover the
 * reconnect budget it now shares with `DocSession`.
 */
describe('useAutomergeDoc reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function tokenFetch() {
    return vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ token: 't', wsUrl: '/collaboration', engine: 'automerge' }),
      ) as unknown as typeof fetch;
  }

  async function mount(fetchImpl: typeof fetch, docName: string) {
    const rendered = renderHook(
      () =>
        useAutomergeDoc({
          docName,
          WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        }),
      { wrapper: wrapper(fetchImpl) },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return rendered;
  }

  it('rebuilds the socket with a fresh token after a drop', async () => {
    const fetchMock = tokenFetch();
    const { result } = await mount(fetchMock, 'r/1');

    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.serverSend(A.save(A.from<Record<string, unknown>>({ content: 'hello' })));
    });
    expect(result.current.synced).toBe(true);

    act(() => first.close(1006));
    expect(result.current.status).toBe('disconnected');
    expect(result.current.synced).toBe(false);

    // Backoff: first retry after ~1s, with a token fetched again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => FakeWebSocket.instances[1]!.open());
    expect(result.current.status).toBe('connected');
  });

  it('keeps changes made while disconnected and flushes them on reconnect', async () => {
    const { result } = await mount(tokenFetch(), 'r/2');

    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.serverSend(A.save(A.from<Record<string, unknown>>({ content: '' })));
    });
    act(() => first.close(1006));

    // The user goes on typing into a document that stopped syncing.
    act(() => {
      result.current.change((d) => {
        (d as { content: string }).content = 'typed while offline';
      });
    });
    expect(result.current.pendingChanges).toBe(1);

    // The debounced send fires while there is no socket: nothing is sent, and
    // nothing is dropped either.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(first.sent).toHaveLength(0);
    expect(result.current.pendingChanges).toBe(1);

    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());

    expect(second.sent).toHaveLength(1);
    const flushed = A.load<{ content?: string }>(new Uint8Array(second.sent[0]!));
    expect(flushed.content).toBe('typed while offline');
    expect(result.current.pendingChanges).toBe(0);
  });

  it('does not retry a 4003 close, and keeps the reason it was refused', async () => {
    const fetchMock = tokenFetch();
    const { result } = await mount(fetchMock, 'r/3');

    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.close(4003, 'no access'));

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('4003');
    expect(result.current.error?.message).toContain('no access');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an engine that is not automerge', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
      ) as unknown as typeof fetch;
    const { result } = await mount(fetchMock, 'r/4');

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('requires engine=automerge');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after 5 attempts, keeping the last real failure as cause', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response('nope', { status: 500 }),
      ) as unknown as typeof fetch;
    const { result } = await mount(fetchMock, 'r/5');

    expect(result.current.status).toBe('error');

    // 1s + 2s + 4s + 8s + 15s (capped) of retries, then the budget is spent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1 + 5);
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toContain('reconnect: exceeded 5 attempts');
    // The exhausted error names what actually kept failing, and carries it.
    expect(result.current.error?.message).toContain('500');
    expect((result.current.error?.cause as Error | undefined)?.message).toContain('500');
  });
});
