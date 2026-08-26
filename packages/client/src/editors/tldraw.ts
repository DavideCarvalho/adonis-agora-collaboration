import type { CollabDoc } from '../docs/types.js';
import type { CollabEditorAdapter } from './types.js';

/**
 * Espelho do snapshot tldraw: `doc.read(editorId)` guarda
 * `{ snapshot }` (records + schema), suficiente pra reidratar
 * `createTLStore({ snapshot })` em qualquer peer.
 */
export interface TldrawScene<S = Record<string, unknown>> {
  snapshot: S;
}

export function createTldrawAdapter<S = Record<string, unknown>>(): CollabEditorAdapter<
  TldrawScene<S>
> {
  const empty = (): TldrawScene<S> => ({ snapshot: { records: [] } }) as TldrawScene<S>;
  return {
    empty,
    create: (doc: CollabDoc, editorId: string) => ({
      get state(): TldrawScene<S> {
        return doc.read<TldrawScene<S>>(editorId) ?? empty();
      },
      update(next) {
        doc.write(editorId, next);
      },
    }),
  };
}
