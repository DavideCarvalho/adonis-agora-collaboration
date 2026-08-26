import type { CollabDoc } from '../docs/types.js';
import type { CollabEditorAdapter } from './types.js';

/**
 * Espelho da cena Excalidraw: guarda `{ elements, appState }` na chave do
 * editor. Padrão self-hosted (o protocolo `collab` do Excalidraw é
 * proprietário e não é usado aqui).
 */
export interface ExcalidrawScene<S = unknown> {
  elements: S[];
  appState?: Record<string, unknown>;
}

export function createExcalidrawAdapter<S = unknown>(): CollabEditorAdapter<ExcalidrawScene<S>> {
  return {
    empty: () => ({ elements: [] }),
    create: (doc: CollabDoc, editorId: string) => {
      const read = (): ExcalidrawScene<S> =>
        doc.read<ExcalidrawScene<S>>(editorId) ?? { elements: [] };
      return {
        get state(): ExcalidrawScene<S> {
          return read();
        },
        update(next) {
          doc.write(editorId, next);
        },
      };
    },
  };
}
