import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationProvider } from '../src/context.js';
import { YjsCollabDoc } from '../src/docs/index.js';
import {
  createExcalidrawAdapter,
  createTextAdapter,
  createTldrawAdapter,
} from '../src/editors/index.js';
import type { CollabEditorAdapter } from '../src/editors/types.js';
import { useCollabEditor } from '../src/hooks/use_collab_editor.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

function makeWrapper() {
  const { factory } = fakeTransportFactory();
  return {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(
        CollaborationProvider,
        {
          baseUrl: 'https://api.app',
          createTransport: factory,
          fetchImpl: (async (input: string | URL | Request) =>
            input.toString().includes('/collaboration/token')
              ? Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' })
              : new Response('nf', { status: 404 })) as typeof fetch,
        },
        children,
      ),
  };
}

describe('editor adapters', () => {
  it('excalidraw adapter round-trips a scene through the Y.Doc', () => {
    const doc = new Y.Doc();
    const adapter = createExcalidrawAdapter<unknown>();
    const view = adapter.create(new YjsCollabDoc(doc), 'lousa');

    expect(view.state.elements).toEqual([]);
    view.update({ elements: [{ id: 'a' }], appState: { zoom: 1 } });

    const other = adapter.create(new YjsCollabDoc(doc), 'lousa');
    expect(other.state.elements).toEqual([{ id: 'a' }]);
    expect(other.state.appState?.zoom).toBe(1);
  });

  it('tldraw and text adapters mirror their keys', () => {
    const doc = new Y.Doc();
    const tldraw = createTldrawAdapter<{ records: unknown[] }>();
    tldraw.create(new YjsCollabDoc(doc), 'board').update({ snapshot: { records: [1, 2] } });
    expect(tldraw.create(new YjsCollabDoc(doc), 'board').state.snapshot.records).toHaveLength(2);

    const text = createTextAdapter();
    const txt = text.create(new YjsCollabDoc(doc), 'notes');
    txt.update('hello');
    expect(text.create(new YjsCollabDoc(doc), 'notes').state).toBe('hello');
  });
});

describe('useCollabEditor', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('exposes scene state through the session Y.Doc', async () => {
    const { wrapper } = makeWrapper();
    let result: ReturnType<typeof useCollabEditor<{ elements: unknown[] }>> | undefined;

    function Probe() {
      result = useCollabEditor({
        docName: 'lousas/1',
        editorId: 'excalidraw',
        adapter: createExcalidrawAdapter<unknown>(),
      });
      return null;
    }

    await act(async () => {
      render(wrapper({ children: createElement(Probe) }));
    });

    expect(result?.state.elements).toEqual([]);
    act(() => result?.update({ elements: [{ id: 'z' }] }));
    expect(result?.state.elements).toEqual([{ id: 'z' }]);
  });
});

describe('useCollabEditor reactivity', () => {
  /**
   * `new YjsCollabDoc(session.doc)` was built in the render body, so the
   * memoized adapter view and the `useSyncExternalStore` subscribe both got
   * a new identity on every render — the Y.Doc 'update' listener was torn
   * down and re-added each time, and the snapshot had to be cached by
   * `JSON.stringify(scene)` (O(scene) per stroke) just to stop that becoming
   * a loop.
   */
  it('does not rebuild the adapter view or re-subscribe on every render', async () => {
    const { wrapper } = makeWrapper();
    const base = createExcalidrawAdapter<unknown>();
    let creates = 0;
    const adapter: CollabEditorAdapter<{ elements: unknown[]; appState?: unknown }> = {
      empty: base.empty,
      create: (doc, editorId) => {
        creates += 1;
        return base.create(doc, editorId);
      },
    };

    const { result, rerender } = renderHook(
      () => useCollabEditor({ docName: 'lousas/render', editorId: 'excalidraw', adapter }),
      { wrapper: ({ children }) => wrapper({ children }) },
    );

    await waitFor(() => expect(result.current.state).toBeDefined());
    const before = creates;
    const state = result.current.state;

    rerender();
    rerender();
    rerender();

    expect(creates).toBe(before);
    // And the snapshot stays referentially stable with no document update.
    expect(result.current.state).toBe(state);

    // A real write still flows through.
    act(() => result.current.update({ elements: [{ id: 'q' }] }));
    expect(result.current.state.elements).toEqual([{ id: 'q' }]);
  });
});
