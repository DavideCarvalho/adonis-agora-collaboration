import type { CollabDoc, RichTextDoc } from '../docs/types.js';
import type { CollabEditorAdapter } from './types.js';

/**
 * Espelho de texto puro sobre `doc.read(editorId)` (monaco/textarea). Para
 * texto rico use a doc Yjs e o binding Tiptap diretamente.
 */
export function createTextAdapter(): CollabEditorAdapter<string> {
  return {
    empty: () => '',
    create: (doc: CollabDoc, editorId: string) => {
      const rich = doc as RichTextDoc;
      const get = (): string => {
        const v = doc.read<string>(editorId);
        if (v !== undefined) return v;
        const ytext = rich.getText?.(editorId) as { toString(): string } | undefined;
        return ytext ? ytext.toString() : '';
      };
      return {
        get state(): string {
          return get();
        },
        update(next) {
          doc.write(editorId, next);
        },
      };
    },
  };
}
