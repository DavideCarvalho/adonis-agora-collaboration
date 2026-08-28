import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { CollaborationProvider } from '../src/context.js';
import { useCollabDoc } from '../src/hooks/use_collab_doc.js';
import type { CollabStatus, CollabTransport } from '../src/types.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

/** A transport that can tell "socket open" from "initial state applied". */
class SyncAwareTransport implements CollabTransport {
  #status: CollabStatus = 'connecting';
  #synced = false;
  #listeners = new Set<() => void>();

  constructor(readonly doc: Y.Doc) {}

  getStatus(): CollabStatus {
    return this.#status;
  }

  isSynced(): boolean {
    return this.#synced;
  }

  set(status: CollabStatus, synced: boolean): void {
    this.#status = status;
    this.#synced = synced;
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy(): void {}
}

function wrap(createTransport: (doc: Y.Doc) => CollabTransport) {
  return function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        createTransport: (_info, doc) => createTransport(doc),
        fetchImpl: vi
          .fn()
          .mockImplementation(async () =>
            Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
          ) as unknown as typeof fetch,
      },
      children,
    );
  };
}

describe('synced', () => {
  /**
   * The transport layer only ever mapped Hocuspocus's `status`, so
   * `'connected'` meant "socket open", not "initial state applied". The docs
   * prescribed gating `editable` on it, and a dropped WebSocket then turned
   * the editor read-only with no way to tell the two apart.
   */
  it('reports connected-but-not-yet-synced separately from synced', async () => {
    let transport: SyncAwareTransport | undefined;
    const { result } = renderHook(() => useCollabDoc({ docName: 'docs/synced-1' }), {
      wrapper: wrap((doc) => {
        transport = new SyncAwareTransport(doc);
        return transport;
      }),
    });

    await waitFor(() => expect(transport).toBeDefined());

    act(() => transport?.set('connected', false));
    expect(result.current.status).toBe('connected');
    expect(result.current.synced).toBe(false);

    act(() => transport?.set('connected', true));
    expect(result.current.synced).toBe(true);

    // A dropped socket un-syncs: the next connection has to replay the sync.
    act(() => transport?.set('disconnected', false));
    expect(result.current.synced).toBe(false);
  });

  it('falls back to the status for transports that cannot report sync', async () => {
    const { factory, created } = fakeTransportFactory();
    const { result } = renderHook(() => useCollabDoc({ docName: 'docs/synced-2' }), {
      wrapper: wrap((doc) => factory({ token: 't', wsUrl: '/x', engine: 'yjs' }, doc, 'd')),
    });

    await waitFor(() => expect(created).toHaveLength(1));
    expect(result.current.synced).toBe(false);

    act(() => created[0]?.setStatus('connected'));
    expect(result.current.synced).toBe(true);
  });
});

describe('HocuspocusCollabTransport', () => {
  it("maps Hocuspocus's synced event and resets it when the socket drops", async () => {
    const handlers = new Map<string, (arg: never) => void>();
    vi.doMock('@hocuspocus/provider', () => ({
      HocuspocusProvider: class {
        awareness = null;
        on(event: string, handler: (arg: never) => void) {
          handlers.set(event, handler);
        }
        destroy() {}
      },
    }));
    vi.resetModules();

    const { HocuspocusCollabTransport } = await import('../src/transports/hocuspocus.js');
    const Yjs = await import('yjs');
    const transport = new HocuspocusCollabTransport(
      { token: 't', wsUrl: '/collaboration', engine: 'yjs' },
      new Yjs.Doc(),
      'docs/1',
    );

    let notified = 0;
    transport.subscribe(() => notified++);

    handlers.get('status')?.({ status: 'connected' } as never);
    expect(transport.getStatus()).toBe('connected');
    // Socket open is not the same as state applied.
    expect(transport.isSynced()).toBe(false);

    handlers.get('synced')?.({ state: true } as never);
    expect(transport.isSynced()).toBe(true);
    expect(notified).toBe(2);

    handlers.get('status')?.({ status: 'disconnected' } as never);
    expect(transport.isSynced()).toBe(false);

    vi.doUnmock('@hocuspocus/provider');
    vi.resetModules();
  });
});
