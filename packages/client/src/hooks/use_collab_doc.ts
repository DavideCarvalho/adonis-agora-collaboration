import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import type { CollabDoc } from '../docs/types.js';
import { YjsCollabDoc } from '../docs/yjs_doc.js';
import type { DocSessionSnapshot } from '../session.js';
import type { CollabStatus } from '../types.js';

export interface UseCollabDocOptions {
  docName: string;
}

export interface UseCollabDocResult {
  /** Y.Doc compartilhado (estável enquanto o provider viver). */
  doc: Y.Doc;
  /**
   * O mesmo documento pela seam `CollabDoc` (`read`/`write`/`onUpdate`) —
   * é o que `useExcalidrawSync` e os adapters de editor consomem.
   */
  collabDoc: CollabDoc;
  status: CollabStatus;
  /**
   * `true` quando o estado inicial do servidor já foi aplicado no doc.
   * `status === 'connected'` só diz que o socket abriu — gate de edição
   * costuma querer este aqui.
   */
  synced: boolean;
  error: Error | null;
}

const SERVER_SNAPSHOT: DocSessionSnapshot = { status: 'connecting', error: null, synced: false };

/**
 * Placeholder para SSR: no servidor não abrimos sessão nenhuma, mas o
 * contrato devolve um `Y.Doc`. Um único doc vazio compartilhado evita alocar
 * (e vazar) um documento por render de servidor.
 */
let serverDoc: Y.Doc | undefined;
function getServerDoc(): Y.Doc {
  if (!serverDoc) serverDoc = new Y.Doc();
  return serverDoc;
}

/**
 * Conecta ao documento colaborativo e devolve o Y.Doc + status.
 *
 * A sessão é contada por referência: montar segura, desmontar solta, e o
 * último a sair fecha o socket sem destruir o `Y.Doc` — remontar (voltar na
 * navegação, StrictMode) reconecta sobre o mesmo documento.
 *
 * ```tsx
 * const { doc, status, synced } = useCollabDoc({ docName: 'researches/42/writing' })
 * ```
 */
export function useCollabDoc(options: UseCollabDocOptions): UseCollabDocResult {
  const { docName } = options;
  const context = useCollaborationContext();

  // Lazy e no-op no servidor: `getOrCreateSession` muta o Map do provider e
  // constrói um Y.Doc. Efeitos não rodam no SSR, então chamar isso no corpo
  // do render vazava uma sessão por render de servidor — além de ser um
  // render impuro sob React concorrente.
  const isBrowser = typeof window !== 'undefined';
  const session = useMemo(
    () => (isBrowser ? getOrCreateSession(context, docName) : null),
    [context, docName, isBrowser],
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => session?.subscribe(onStoreChange) ?? (() => {}),
    [session],
  );
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? SERVER_SNAPSHOT, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);

  const doc = session?.doc ?? getServerDoc();
  const collabDoc = useMemo(() => new YjsCollabDoc(doc), [doc]);

  // Refcount, não destroy. Destruir o Y.Doc no unmount deixava o Hocuspocus
  // Provider com callbacks enfileirados apontando pra um doc destruído
  // (`Cannot read properties of undefined (reading 'startTime')` → React
  // #185), e devolvia um cadáver de sessão na remontagem. `retain()` devolve
  // o `release` correspondente; o último a soltar fecha o transporte.
  useEffect(() => session?.retain(), [session]);

  return {
    doc,
    collabDoc,
    status: snapshot.status,
    synced: snapshot.synced,
    error: snapshot.error,
  };
}
