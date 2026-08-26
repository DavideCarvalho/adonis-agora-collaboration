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
  onclose: (() => void) | null = null;
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
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function wrapper() {
  const { factory } = fakeTransportFactory();
  return ({ children }: { children: React.ReactNode }) =>
    createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        createTransport: factory,
        fetchImpl: (async (input: string | URL | Request) => {
          if (input.toString().includes('/collaboration/token')) {
            return Response.json({ token: 't', wsUrl: '/collaboration', engine: 'automerge' });
          }
          return new Response('not found', { status: 404 });
        }) as typeof fetch,
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
