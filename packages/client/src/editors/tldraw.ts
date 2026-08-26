import type * as Y from 'yjs';
import type { CollabEditorAdapter } from './types.js';

/**
 * tldraw snapshot mirror: `doc.getMap(editorId).get('snapshot')` holds the
 * JSON store snapshot (records + schema), enough to rehydrate
 * `createTLStore({ snapshot })` on any peer.
 */
export interface TldrawScene<S = Record<string, unknown>> {
  snapshot: S;
}

export function createTldrawAdapter<S = Record<string, unknown>>(): CollabEditorAdapter<
  TldrawScene<S>
> {
  const SNAPSHOT = 'snapshot';

  return {
    empty: () => ({ snapshot: { records: [] } }) as TldrawScene<S>,
    create: (doc, editorId) => {
      const map = doc.getMap<unknown>(editorId);
      const empty = () => ({ snapshot: { records: [] } }) as TldrawScene<S>;
      return {
        get state(): TldrawScene<S> {
          return {
            snapshot: (map.get(SNAPSHOT) as S | undefined) ?? empty().snapshot,
          };
        },
        update(next) {
          doc.transact(() => map.set(SNAPSHOT, next.snapshot));
        },
      };
    },
  };
}
