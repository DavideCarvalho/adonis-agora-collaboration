/**
 * Heavy engine dependencies, loaded on first use instead of when the package
 * is imported.
 *
 * Importing `@adonis-agora/collaboration` (the root entry re-exports every
 * driver class) used to evaluate Automerge's WASM build, `@hocuspocus/server`
 * and `@hocuspocus/transformer` (Tiptap + ProseMirror) in every process — ace
 * commands, queue workers, and web pods that never open a document. Each
 * loader below imports its module once per process; a failed import is not
 * cached, so the next call retries.
 */
function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export type AutomergeModule = typeof import('@automerge/automerge');
export type TiptapTransformerType = typeof import('@hocuspocus/transformer').TiptapTransformer;
export type HocuspocusClass = typeof import('@hocuspocus/server').Hocuspocus;

/** `@automerge/automerge` — the automerge driver only. */
export const loadAutomerge: () => Promise<AutomergeModule> = lazyImport(
  () => import('@automerge/automerge'),
);

/** `TiptapTransformer` — text extraction and diffs of Yjs documents. */
export const loadTiptapTransformer: () => Promise<TiptapTransformerType> = lazyImport(() =>
  import('@hocuspocus/transformer').then((module) => module.TiptapTransformer),
);

/** `Hocuspocus` — the yjs driver's sync engine. */
export const loadHocuspocus: () => Promise<HocuspocusClass> = lazyImport(() =>
  import('@hocuspocus/server').then((module) => module.Hocuspocus),
);
