import type { CollabDoc } from '../docs/types.js';

/**
 * Editor adapters decouple a frontend surface (Excalidraw, tldraw, text)
 * from the CRDT document. Each adapter knows how to read/write its scene
 * against a {@link CollabDoc}, so hooks stay engine-aware: the same adapter
 * works on Yjs or Automerge.
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
  /** Binds the adapter to a document key inside the doc. */
  create(doc: CollabDoc, editorId: string): CollabEditorView<S>;
}
