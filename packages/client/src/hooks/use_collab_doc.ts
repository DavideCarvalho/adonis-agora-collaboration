import { useEffect, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import type { CollabStatus } from '../types.js';

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
export function useCollabDoc(docName: string): UseCollabDocResult {
  const context = useCollaborationContext();
  const session = getOrCreateSession(context, docName);

  const status = useSyncExternalStore(
    (onStoreChange) => session.subscribe(onStoreChange),
    () => session.getStatus(),
    () => 'connecting' as CollabStatus,
  );

  // Garante start mesmo sem re-render subsequente; sessão é cacheada no
  // provider, então este efeito é barato em re-montagens.
  useEffect(() => {
    void session.start();
    return () => {
      // Sem destroy aqui: a sessão sobrevive ao unmount do componente.
    };
  }, [session]);

  return { doc: session.doc, status, error: session.error };
}
