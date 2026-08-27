import { renderHook, waitFor } from '@testing-library/react';
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

  constructor(readonly doc: Y.Doc) {
    this.awareness = new AwarenessProtocol.Awareness(doc);
  }

  getStatus(): CollabStatus {
    return 'connected';
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy(): void {
    this.awareness.destroy();
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const fetchImpl = vi.fn(async () =>
    Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
  );
  return createElement(
    CollaborationProvider,
    {
      baseUrl: 'https://api.app',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createTransport: (_info, doc) => new AwareTransport(doc),
    },
    children,
  );
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
});
