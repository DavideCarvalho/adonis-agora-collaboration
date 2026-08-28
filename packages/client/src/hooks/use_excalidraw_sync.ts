import { useEffect, useMemo, useRef } from 'react';
import { createExcalidrawAdapter } from '../editors/excalidraw.js';
import type { CollabDoc } from '../docs/types.js';

/**
 * Minimal imperative API that Excalidraw exposes for programmatic control.
 * We avoid a hard dependency on `@excalidraw/excalidraw` types — the app
 * passes the real `ExcalidrawImperativeAPI` from its own install.
 */
export interface ExcalidrawAPIHandle {
  onChange(cb: (elements: readonly Record<string, unknown>[]) => void): () => void;
  updateScene(scene: { elements: readonly Record<string, unknown>[] }): void;
}

export interface UseExcalidrawSyncOptions {
  /** Documento colaborativo (do `useCollabDoc`). Pode ser `null` enquanto conecta. */
  doc: CollabDoc | null;
  /** API imperativa do Excalidraw (`excalidrawAPI` do componente). */
  excalidrawAPI: ExcalidrawAPIHandle | null;
  /** Chave do editor no doc (default `'excalidraw'`). */
  editorId?: string;
}

/**
 * Liga um documento colaborativo à API imperativa do Excalidraw.
 *
 * - **Desenho local** → grava os elements no Y.Doc (replica via WebSocket).
 * - **Mudança remota** → `updateScene` no canvas.
 * - **Ao montar** → restaura o estado salvo do doc.
 *
 * ```tsx
 * const [api, setApi] = useState(null)
 * const { doc } = useCollabDoc({ docName: 'lousas/1' })
 * useExcalidrawSync({ doc, excalidrawAPI: api })
 * <Excalidraw excalidrawAPI={setApi} />
 * ```
 */
export function useExcalidrawSync({
  doc,
  excalidrawAPI,
  editorId = 'excalidraw',
}: UseExcalidrawSyncOptions) {
  const adapter = useMemo(() => createExcalidrawAdapter(), []);
  const view = useMemo(() => (doc ? adapter.create(doc, editorId) : null), [adapter, doc, editorId]);
  const localFlag = useRef<symbol | null>(null);

  // Ao montar, carrega o estado inicial do doc no canvas.
  useEffect(() => {
    if (!excalidrawAPI || !view) return;
    const scene = view.state;
    if (scene.elements.length > 0) {
      excalidrawAPI.updateScene({
        elements: scene.elements as readonly Record<string, unknown>[],
      });
    }
  }, [excalidrawAPI, view]);

  // Desenho local → escreve no doc.
  useEffect(() => {
    if (!excalidrawAPI || !view) return;
    const unsub = excalidrawAPI.onChange((els) => {
      const plain = (els as readonly Record<string, unknown>[]).map((e) => ({ ...e }));
      localFlag.current = Symbol('local');
      view.update({ elements: plain });
      queueMicrotask(() => {
        localFlag.current = null;
      });
    });
    return () => unsub?.();
  }, [excalidrawAPI, view]);

  // Mudança remota → atualiza o canvas.
  useEffect(() => {
    if (!doc || !excalidrawAPI || !view) return;
    const unsub = doc.onUpdate(() => {
      if (localFlag.current || !excalidrawAPI) return;
      const scene = view.state;
      if (scene.elements.length > 0) {
        excalidrawAPI.updateScene({
          elements: scene.elements as readonly Record<string, unknown>[],
        });
      }
    });
    return () => unsub();
  }, [doc, excalidrawAPI, view]);
}