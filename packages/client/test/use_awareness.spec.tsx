import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as AwarenessProtocol from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import { CollaborationProvider } from '../src/context.js';
import { useAwareness } from '../src/hooks/use_awareness.js';
import type { CollabStatus, CollabTransport } from '../src/types.js';

/** A transport that actually has an awareness channel, like Hocuspocus does. */
class AwareTransport implements CollabTransport {
  readonly awareness: AwarenessProtocol.Awareness;
  #listeners = new Set<() => void>();

  constructor(
    readonly doc: Y.Doc,
    private readonly status: CollabStatus = 'connected',
  ) {
    this.awareness = new AwarenessProtocol.Awareness(doc);
  }

  getStatus(): CollabStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy(): void {
    this.awareness.destroy();
  }
}

let lastTransport: AwareTransport | undefined;

function makeWrapper(status: CollabStatus = 'connected') {
  return function wrapper({ children }: { children: ReactNode }) {
    const fetchImpl = vi.fn(async () =>
      Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
    );
    return createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        createTransport: (_info, doc) => {
          lastTransport = new AwareTransport(doc, status);
          return lastTransport;
        },
      },
      children,
    );
  };
}

const wrapper = makeWrapper();

/** Pushes a peer's state into `target`, exactly like an inbound WS frame. */
function joinAsRemotePeer(
  target: AwarenessProtocol.Awareness,
  user: { userId: string; name: string },
) {
  const remote = new AwarenessProtocol.Awareness(new Y.Doc());
  remote.setLocalStateField('user', user);
  AwarenessProtocol.applyAwarenessUpdate(
    target,
    AwarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]),
    'remote',
  );
  return remote;
}

describe('useAwareness', () => {
  /**
   * Tiptap's CollaborationCursor takes a `provider` and reads
   * `provider.awareness` off it, so the hook has to hand back the object
   * itself — a peers snapshot cannot drive remote carets.
   */
  it('exposes the transport awareness object, not just a peers snapshot', async () => {
    const { result } = renderHook(() => useAwareness({ docName: 'docs/9' }), { wrapper });

    await waitFor(() => expect(result.current.awareness).not.toBeNull());
    expect(typeof result.current.awareness?.getStates).toBe('function');
  });

  it('still reports peers', async () => {
    const { result } = renderHook(() => useAwareness({ docName: 'docs/10' }), { wrapper });

    await waitFor(() => expect(result.current.awareness).not.toBeNull());
    expect(result.current.peers).toEqual([]);
  });

  /**
   * The transport only exists after `fetchToken` resolves, so the effect
   * (deps `[session]`, stable) used to read `session.transport?.awareness`
   * once, get `null`, and subscribe to `'change'` on nothing. Presence then
   * only refreshed when the *status* happened to change — so a transport
   * that reports the same status it started with left `awareness` null
   * forever.
   */
  it('picks up the awareness channel that only appears after the token resolves', async () => {
    const { result } = renderHook(() => useAwareness({ docName: 'docs/11' }), {
      wrapper: makeWrapper('connecting'),
    });

    await waitFor(() => expect(result.current.awareness).not.toBeNull());
    expect(result.current.status).toBe('connecting');
  });

  it('refreshes peers on an awareness change with no status transition', async () => {
    const { result } = renderHook(() => useAwareness({ docName: 'docs/12' }), { wrapper });
    await waitFor(() => expect(result.current.awareness).not.toBeNull());

    const channel = result.current.awareness as AwarenessProtocol.Awareness;
    act(() => void joinAsRemotePeer(channel, { userId: 'u2', name: 'Bob' }));

    expect(result.current.peers).toEqual([
      { clientId: expect.any(Number), userId: 'u2', name: 'Bob', avatarUrl: null },
    ]);
  });

  /**
   * `setLocalState` appeared nowhere in src/, so the `user` field that
   * `snapshotPeers` reads could never be populated through the public API —
   * every peer showed up nameless.
   */
  it('publishes the local identity so other peers can read it', async () => {
    const { result } = renderHook(() => useAwareness({ docName: 'docs/13' }), { wrapper });
    await waitFor(() => expect(result.current.awareness).not.toBeNull());

    act(() => result.current.setLocalState({ user: { userId: 'me', name: 'Ana' } }));

    const channel = result.current.awareness as AwarenessProtocol.Awareness;
    expect(channel.getLocalState()).toEqual({ user: { userId: 'me', name: 'Ana' } });

    // What a remote client would decode off the wire.
    const remote = new AwarenessProtocol.Awareness(new Y.Doc());
    AwarenessProtocol.applyAwarenessUpdate(
      remote,
      AwarenessProtocol.encodeAwarenessUpdate(channel, [channel.clientID]),
      'wire',
    );
    expect(remote.getStates().get(channel.clientID)).toEqual({
      user: { userId: 'me', name: 'Ana' },
    });
  });

  it('publishes the `user` option without the caller calling setLocalState', async () => {
    const { result } = renderHook(
      () => useAwareness({ docName: 'docs/14', user: { userId: 'me', name: 'Ana' } }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.awareness).not.toBeNull());

    await waitFor(() =>
      expect(result.current.awareness?.getLocalState()).toEqual({
        user: { userId: 'me', name: 'Ana' },
      }),
    );
  });
});
