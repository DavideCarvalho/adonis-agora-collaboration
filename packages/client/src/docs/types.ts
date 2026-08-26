/**
 * Abstração de documento colaborativo — a seam que desacopla os adapters de
 * editor (Excalidraw/tldraw/texto) do CRDT de baixo.
 *
 * Tanto Yjs quanto Automerge satisfazem este contrato: o adapter só enxerga
 * `read`/`write`/`onUpdate`. Quem decide a implementação é o `useCollabEditor`,
 * resolvendo a engine pelo token que o server devolve.
 */
export interface CollabDoc {
  /** Lê o valor de uma chave (undefined se ausente). */
  read<T>(key: string): T | undefined;
  /** Escreve o valor de uma chave (grava no CRDT de forma transacional). */
  write(key: string, value: unknown): void;
  /** Assina mudanças; retorna unsubscribe. */
  onUpdate(callback: () => void): () => void;
}

/** Texto rico (Yjs). Sem isso, Tiptap/ProseMirror não conseguem editar. */
export interface RichTextDoc extends CollabDoc {
  getText(key: string): unknown;
}
