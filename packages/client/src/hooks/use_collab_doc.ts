import { useEffect, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import type { CollabStatus } from '../types.js';

export interface UseCollabDocOptions {
  docName: string;
}

export interface UseCollabDocResult {
  /** Y.Doc compartilhado (estável enquanto o provider viver). */
  doc: Y.Doc;
  status: CollabStatus;
  error: Error | null;
}

/**
 * Conecta ao documento colaborativo e devolve o Y.Doc + status.
 *
 * ```tsx
 * const { doc, status } = useCollabDoc('researches/42/writing')
 * ```
 */
export function useCollabDoc(options: UseCollabDocOptions): UseCollabDocResult {
  const { docName } = options;
  const context = useCollaborationContext();
  const session = getOrCreateSession(context, docName);

  const status = useSyncExternalStore(
    (onStoreChange) => session.subscribe(onStoreChange),
    () => session.getStatus(),
    () => 'connecting' as CollabStatus,
  );

  // Garante start no mount. No cleanup destruímos a sessão: o Hocuspocus
  // Provider enfileira callbacks (requestIdleCallback, setTimeout) que
  // tentam acessar o Y.Doc e o awareness — se o componente re-monta (React
  // 18 StrictMode, navegação), o `doc` antigo pode estar destruído e o
  // callback quebra com `Cannot read properties of undefined (reading
  // 'startTime')`, que dispara o re-render loop do Tiptap Collaboration
  // (React #185). Destruir a sessão garante que timers e listeners são
  // limpos junto com o doc.
  useEffect(() => {
    void session.start();
    return () => {
      session.destroy();
    };
  }, [session]);

  return { doc: session.doc, status, error: session.error };
}
