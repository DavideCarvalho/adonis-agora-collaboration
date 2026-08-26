import type * as Y from 'yjs';
import type { CollabEditorAdapter } from './types.js';

/**
 * Excalidraw scene mirror: the element array is JSON-serialized under
 * `doc.getMap(editorId).get('elements')`. Standard self-hosted pattern
 * (Excalidraw's own `collab` protocol is proprietary and not used here).
 */
export interface ExcalidrawScene<S = unknown> {
  elements: S[];
  appState?: Record<string, unknown>;
}

export function createExcalidrawAdapter<S = unknown>(): CollabEditorAdapter<ExcalidrawScene<S>> {
  const ELEMENTS = 'elements';
  const APP_STATE = 'appState';

  return {
    empty: () => ({ elements: [] }),
    create: (doc, editorId) => {
      const map = doc.getMap<unknown>(editorId);

      const read = (): ExcalidrawScene<S> => {
        const elements = (map.get(ELEMENTS) as S[] | undefined) ?? [];
        const appState = map.get(APP_STATE) as Record<string, unknown> | undefined;
        return appState ? { elements, appState } : { elements };
      };

      return {
        get state(): ExcalidrawScene<S> {
          return read();
        },
        update(next) {
          doc.transact(() => {
            map.set(ELEMENTS, next.elements);
            if (next.appState) map.set(APP_STATE, next.appState);
          });
        },
      };
    },
  };
}
