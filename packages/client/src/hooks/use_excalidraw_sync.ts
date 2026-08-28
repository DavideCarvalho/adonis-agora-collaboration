import { useEffect, useMemo, useRef } from 'react';
import type * as Y from 'yjs';
import type { CollabDoc } from '../docs/types.js';
import { YjsCollabDoc } from '../docs/yjs_doc.js';
import { createExcalidrawAdapter } from '../editors/excalidraw.js';

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
  /**
   * Documento colaborativo. Aceita tanto o `Y.Doc` quanto o `collabDoc` que
   * o `useCollabDoc` devolve — o wrapper `YjsCollabDoc` é aplicado aqui
   * quando necessário. Pode ser `null` enquanto conecta.
   */
  doc: CollabDoc | Y.Doc | null;
  /** API imperativa do Excalidraw (`excalidrawAPI` do componente). */
  excalidrawAPI: ExcalidrawAPIHandle | null;
  /** Chave do editor no doc (default `'excalidraw'`). */
  editorId?: string;
}

/** `Y.Doc` não tem `read`/`write`/`onUpdate` — envolve quando for um. */
function isCollabDoc(doc: CollabDoc | Y.Doc): doc is CollabDoc {
  const candidate = doc as Partial<CollabDoc>;
  return (
    typeof candidate.read === 'function' &&
    typeof candidate.write === 'function' &&
    typeof candidate.onUpdate === 'function'
  );
}

/**
 * Liga um documento colaborativo à API imperativa do Excalidraw.
 *
 * - **Desenho local** → grava os elements no doc (replica via WebSocket).
 * - **Mudança remota** → `updateScene` no canvas.
 * - **Ao montar** → restaura o estado salvo do doc (inclusive quando o
 *   estado salvo é uma lousa vazia).
 *
 * ```tsx
 * const [api, setApi] = useState<ExcalidrawAPIHandle | null>(null)
 * const { doc } = useCollabDoc({ docName: 'lousas/1' })
 * useExcalidrawSync({ doc, excalidrawAPI: api })
 *
 * return <Excalidraw excalidrawAPI={setApi} />
 * ```
 *
 * ## Last-write-wins, e o que isso custa
 *
 * A cena inteira mora numa única chave do documento (`Y.Map[editorId].value`),
 * então cada `onChange` grava o array de elements completo. O CRDT converge,
 * mas **sobre a cena como unidade**: duas pessoas mexendo em formas
 * diferentes no mesmo instante produzem duas escritas de cena inteira e a
 * última vence — o traço da outra some. Não há merge por elemento aqui.
 *
 * Na prática dá pra conviver: as edições aparecem, as pessoas trabalham em
 * regiões diferentes e os cursores de presença mantêm distância. Se a
 * concorrência por item importa de verdade, modele cada elemento como sua
 * própria chave e escreva um adapter que faça isso (veja
 * `CollabEditorAdapter`) — este hook não vai te dar isso.
 */
export function useExcalidrawSync({
  doc,
  excalidrawAPI,
  editorId = 'excalidraw',
}: UseExcalidrawSyncOptions) {
  const adapter = useMemo(() => createExcalidrawAdapter(), []);
  const collabDoc = useMemo<CollabDoc | null>(() => {
    if (!doc) return null;
    return isCollabDoc(doc) ? doc : new YjsCollabDoc(doc);
  }, [doc]);
  const view = useMemo(
    () => (collabDoc ? adapter.create(collabDoc, editorId) : null),
    [adapter, collabDoc, editorId],
  );
  const localFlag = useRef<symbol | null>(null);

  // Ao montar, carrega o estado inicial do doc no canvas.
  useEffect(() => {
    if (!excalidrawAPI || !view || !collabDoc) return;
    // `elements.length > 0` confundia "documento ainda vazio" com "lousa
    // apagada": depois de um select-all + delete, a cena salva é
    // `{ elements: [] }` e o guard antigo pulava a restauração, então o
    // reload trazia os traços de volta. O que importa é se a chave existe.
    if (collabDoc.read(editorId) === undefined) return;
    excalidrawAPI.updateScene({
      elements: view.state.elements as readonly Record<string, unknown>[],
    });
  }, [collabDoc, editorId, excalidrawAPI, view]);

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
    if (!collabDoc || !excalidrawAPI || !view) return;
    const unsub = collabDoc.onUpdate(() => {
      if (localFlag.current || !excalidrawAPI) return;
      // Mesmo motivo do efeito de mount: um peer que apagou tudo manda
      // `{ elements: [] }` e isso precisa chegar no canvas, senão apagar
      // nunca propaga.
      if (collabDoc.read(editorId) === undefined) return;
      excalidrawAPI.updateScene({
        elements: view.state.elements as readonly Record<string, unknown>[],
      });
    });
    return () => unsub();
  }, [collabDoc, editorId, excalidrawAPI, view]);
}
