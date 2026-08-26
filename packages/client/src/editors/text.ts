import type * as Y from 'yjs';
import type { CollabEditorAdapter } from './types.js';

/** Plain-text mirror over `doc.getText(editorId)` (monaco/textarea surfaces). */
export function createTextAdapter(): CollabEditorAdapter<string> {
  return {
    empty: () => '',
    create: (doc, editorId) => {
      const text = doc.getText(editorId);
      return {
        get state(): string {
          return text.toString();
        },
        update(next) {
          doc.transact(() => {
            text.delete(0, text.length);
            text.insert(0, next);
          });
        },
      };
    },
  };
}
