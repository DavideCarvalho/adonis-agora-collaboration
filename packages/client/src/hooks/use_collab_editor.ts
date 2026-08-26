import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import { YjsCollabDoc } from '../docs/index.js';
import type { CollabDoc } from '../docs/types.js';
import type { CollabEditorAdapter } from '../editors/types.js';
import type { CollabPeer, CollabStatus } from '../types.js';
import { useAwareness } from './use_awareness.js';

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
 */
export function useCollabEditor<S>(options: UseCollabEditorOptions<S>): UseCollabEditorResult<S> {
  const { docName, editorId, adapter, doc } = options;
  const context = useCollaborationContext();
  const session = getOrCreateSession(context, docName);
  const collabDoc = doc ?? new YjsCollabDoc(session.doc);
  const { peers, status } = useAwareness({ docName });

  // Reactivity: any Yjs update re-renders and re-reads the adapter state.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return collabDoc.onUpdate(onStoreChange);
    },
    [collabDoc],
  );

  // Adapter view + stable snapshot: scenes are freshly built objects, so we
  // cache by serialized equality to keep useSyncExternalStore from looping.
  const view = useMemo(() => adapter.create(collabDoc, editorId), [adapter, collabDoc, editorId]);
  const cacheRef = useRef<{ key: string; value: S } | undefined>(undefined);
  const getSnapshot = useCallback((): S => {
    const next = view.state;
    const key = JSON.stringify(next);
    if (cacheRef.current?.key === key) return cacheRef.current.value;
    cacheRef.current = { key, value: next };
    return next;
  }, [view]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { state, update: view.update, status, peers };
}
