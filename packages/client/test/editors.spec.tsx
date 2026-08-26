import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationProvider } from '../src/context.js';
import {
  createExcalidrawAdapter,
  createTextAdapter,
  createTldrawAdapter,
} from '../src/editors/index.js';
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
    const view = adapter.create(doc, 'lousa');

    expect(view.state.elements).toEqual([]);
    view.update({ elements: [{ id: 'a' }], appState: { zoom: 1 } });

    const other = adapter.create(doc, 'lousa');
    expect(other.state.elements).toEqual([{ id: 'a' }]);
    expect(other.state.appState?.zoom).toBe(1);
  });

  it('tldraw and text adapters mirror their keys', () => {
    const doc = new Y.Doc();
    const tldraw = createTldrawAdapter<{ records: unknown[] }>();
    tldraw.create(doc, 'board').update({ snapshot: { records: [1, 2] } });
    expect(tldraw.create(doc, 'board').state.snapshot.records).toHaveLength(2);

    const text = createTextAdapter();
    const txt = text.create(doc, 'notes');
    txt.update('hello');
    expect(text.create(doc, 'notes').state).toBe('hello');
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
