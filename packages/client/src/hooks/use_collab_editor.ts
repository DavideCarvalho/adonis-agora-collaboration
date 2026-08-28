import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CollabDoc } from '../docs/types.js';
import type { CollabEditorAdapter } from '../editors/types.js';
import type { CollabPeer, CollabStatus } from '../types.js';
import { useAwareness } from './use_awareness.js';
import { useCollabDoc } from './use_collab_doc.js';

export interface UseCollabEditorOptions<S> {
  docName: string;
  editorId: string;
  adapter: CollabEditorAdapter<S>;
  /**
   * Doc colaborativo (impl de engine). Omita para Yjs (a doc da sessão);
   * passe `new AutomergeCollabDoc(host)` para engine automerge — os mesmos
   * adapters funcionam com qualquer impl.
   */
  doc?: CollabDoc;
}

export interface UseCollabEditorResult<S> {
  /** Current scene state (editor-agnostic shape from the adapter). */
  state: S;
  /** Writes the next scene into the shared doc. */
  update(next: S): void;
  status: CollabStatus;
  /** True once the server's initial state has been applied to the doc. */
  synced: boolean;
  peers: CollabPeer[];
}

/**
 * Engine-aware, editor-aware view of a collaborative document.
 *
 * The engine comes from the server (token response); the editor from the
 * adapter you pass. Everything Yjs-family (yjs, partykit, partyserver)
 * resolves to a Y.Doc through the existing session seam; the adapter maps
 * its scene (Excalidraw/tldraw/text) into the doc.
 *
 * ```tsx
 * const { state, update, status, peers } = useCollabEditor({
 *   docName: 'lousas/1',
 *   editorId: 'excalidraw',
 *   adapter: createExcalidrawAdapter(),
 * })
 * ```
 *
 * Scene writes are whole-scene replacement (last-write-wins over the whole
 * key), not per-element merging — see the Editors docs.
 */
export function useCollabEditor<S>(options: UseCollabEditorOptions<S>): UseCollabEditorResult<S> {
  const { docName, editorId, adapter, doc } = options;
  const { collabDoc: sessionDoc, status, synced } = useCollabDoc({ docName });
  const { peers } = useAwareness({ docName });

  // Memoized: building the wrapper in the render body gave `subscribe` a new
  // identity on every render, so useSyncExternalStore tore down and re-added
  // the Y.Doc 'update' listener each time.
  const collabDoc = useMemo(() => doc ?? sessionDoc, [doc, sessionDoc]);
  const view = useMemo(() => adapter.create(collabDoc, editorId), [adapter, collabDoc, editorId]);

  // Reactivity: any document update bumps a version and re-reads the adapter
  // state. The scene is a freshly built object on every read, so the snapshot
  // is cached by version — the old cache key was `JSON.stringify(scene)`,
  // which serialized the whole board on every stroke just to decide whether
  // anything changed.
  const versionRef = useRef(0);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      collabDoc.onUpdate(() => {
        versionRef.current += 1;
        onStoreChange();
      }),
    [collabDoc],
  );

  const cacheRef = useRef<{ version: number; view: unknown; value: S } | undefined>(undefined);
  const getSnapshot = useCallback((): S => {
    const cached = cacheRef.current;
    if (cached && cached.version === versionRef.current && cached.view === view) {
      return cached.value;
    }
    const next = view.state;
    cacheRef.current = { version: versionRef.current, view, value: next };
    return next;
  }, [view]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { state, update: view.update, status, synced, peers };
}
