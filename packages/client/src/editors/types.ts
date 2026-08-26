import type * as Y from 'yjs';

/**
 * Editor adapters decouple a frontend surface (Excalidraw, tldraw, text)
 * from the CRDT document. Each adapter knows how to read/write its scene
 * inside a Y.Doc, so hooks stay engine-aware via the transport seam.
 */
export interface CollabEditorView<S> {
  /** Current serializable scene state. */
  state: S;
  /** Applies the next scene state into the shared doc. */
  update(next: S): void;
}

export interface CollabEditorAdapter<S> {
  /** Empty scene for a fresh document. */
  empty(): S;
  /** Binds the adapter to a document key inside the Y.Doc. */
  create(doc: Y.Doc, editorId: string): CollabEditorView<S>;
}
