import { act, render, renderHook } from '@testing-library/react';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationProvider } from '../src/context.js';
import { YjsCollabDoc } from '../src/docs/index.js';
import { useCollabDoc } from '../src/hooks/use_collab_doc.js';
import { type ExcalidrawAPIHandle, useExcalidrawSync } from '../src/hooks/use_excalidraw_sync.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

/** Stand-in for Excalidraw's imperative API — records every scene pushed in. */
function fakeExcalidraw() {
  const scenes: Record<string, unknown>[][] = [];
  let onChange: ((els: readonly Record<string, unknown>[]) => void) | null = null;
  const api: ExcalidrawAPIHandle = {
    onChange(cb) {
      onChange = cb;
      return () => {
        onChange = null;
      };
    },
    updateScene(scene) {
      scenes.push(scene.elements.map((e) => ({ ...e })));
    },
  };
  return {
    api,
    scenes,
    draw: (els: Record<string, unknown>[]) => onChange?.(els),
  };
}

describe('useExcalidrawSync erase', () => {
  /**
   * Both the mount restore and the remote handler were gated on
   * `scene.elements.length > 0`, which conflates "no document yet" with "an
   * empty board". Select-all + delete therefore never reached the canvas and
   * never survived a reload — the strokes came back.
   */
  it('restores a saved-but-empty board on mount (erase survives a reload)', () => {
    const ydoc = new Y.Doc();
    const doc = new YjsCollabDoc(ydoc);
    doc.write('excalidraw', { elements: [{ id: 'a' }] });
    doc.write('excalidraw', { elements: [] }); // select all + delete

    const excalidraw = fakeExcalidraw();
    renderHook(() => useExcalidrawSync({ doc, excalidrawAPI: excalidraw.api }));

    expect(excalidraw.scenes).toEqual([[]]);
  });

  it('does not touch the canvas when the document has no scene yet', () => {
    const doc = new YjsCollabDoc(new Y.Doc());
    const excalidraw = fakeExcalidraw();
    renderHook(() => useExcalidrawSync({ doc, excalidrawAPI: excalidraw.api }));

    expect(excalidraw.scenes).toEqual([]);
  });

  it('propagates a remote erase to the canvas', () => {
    const ydoc = new Y.Doc();
    const doc = new YjsCollabDoc(ydoc);
    doc.write('excalidraw', { elements: [{ id: 'a' }] });

    const excalidraw = fakeExcalidraw();
    renderHook(() => useExcalidrawSync({ doc, excalidrawAPI: excalidraw.api }));
    expect(excalidraw.scenes).toEqual([[{ id: 'a' }]]);

    // A peer selects everything and deletes it.
    act(() => new YjsCollabDoc(ydoc).write('excalidraw', { elements: [] }));

    expect(excalidraw.scenes.at(-1)).toEqual([]);
  });

  it('still writes local drawing into the document', () => {
    const ydoc = new Y.Doc();
    const doc = new YjsCollabDoc(ydoc);
    const excalidraw = fakeExcalidraw();
    renderHook(() => useExcalidrawSync({ doc, excalidrawAPI: excalidraw.api }));

    act(() => excalidraw.draw([{ id: 'b' }]));
    expect(doc.read('excalidraw')).toEqual({ elements: [{ id: 'b' }] });
  });
});

describe('useExcalidrawSync accepts what useCollabDoc returns', () => {
  const wrapper = (children: React.ReactNode) =>
    createElement(
      CollaborationProvider,
      {
        baseUrl: 'https://api.app',
        createTransport: fakeTransportFactory().factory,
        fetchImpl: vi
          .fn()
          .mockImplementation(async () =>
            Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
          ) as unknown as typeof fetch,
      },
      children,
    );

  /**
   * The hook's own docblock passed `useCollabDoc().doc` — a `Y.Doc`, which
   * has no `read`/`write`/`onUpdate`. It did not typecheck, and forced
   * through it threw `doc.read is not a function`.
   */
  it('takes the raw Y.Doc from useCollabDoc', () => {
    const excalidraw = fakeExcalidraw();
    let ydoc: Y.Doc | undefined;

    function Board() {
      const { doc } = useCollabDoc({ docName: 'lousas/1' });
      ydoc = doc;
      const [api] = useState<ExcalidrawAPIHandle | null>(excalidraw.api);
      useExcalidrawSync({ doc, excalidrawAPI: api });
      return null;
    }

    act(() => void render(wrapper(createElement(Board))));
    act(() => excalidraw.draw([{ id: 'c' }]));

    expect(new YjsCollabDoc(ydoc as Y.Doc).read('excalidraw')).toEqual({
      elements: [{ id: 'c' }],
    });
  });

  it('takes the CollabDoc view from useCollabDoc', () => {
    const excalidraw = fakeExcalidraw();
    let collab: ReturnType<typeof useCollabDoc>['collabDoc'] | undefined;

    function Board() {
      const { collabDoc } = useCollabDoc({ docName: 'lousas/2' });
      collab = collabDoc;
      useExcalidrawSync({ doc: collabDoc, excalidrawAPI: excalidraw.api });
      return null;
    }

    act(() => void render(wrapper(createElement(Board))));
    act(() => excalidraw.draw([{ id: 'd' }]));

    expect(collab?.read('excalidraw')).toEqual({ elements: [{ id: 'd' }] });
  });
});
