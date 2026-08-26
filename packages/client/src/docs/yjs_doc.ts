import type * as Y from 'yjs';
import type { CollabDoc, RichTextDoc } from './types.js';

/**
 * Implementação Yjs do contrato CollabDoc — envolve o Y.Doc da sessão e usa
 * `getMap(editorId)` para dados serializáveis e `getText` para texto rico.
 */
export class YjsCollabDoc implements RichTextDoc {
  constructor(private readonly doc: Y.Doc) {}

  read<T>(key: string): T | undefined {
    return this.doc.getMap<unknown>(key).get('value') as T | undefined;
  }

  write(key: string, value: unknown): void {
    this.doc.transact(() => this.doc.getMap<unknown>(key).set('value', value));
  }

  getText(key: string): unknown {
    return this.doc.getText(key);
  }

  onUpdate(callback: () => void): () => void {
    this.doc.on('update', callback);
    return () => this.doc.off('update', callback);
  }
}
