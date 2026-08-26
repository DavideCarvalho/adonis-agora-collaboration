import { useEffect, useState } from 'react';
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import type { CollabPeer, CollabStatus } from '../types.js';

export interface UseAwarenessOptions {
  docName: string;
}

export interface UseAwarenessResult {
  /** Peers conectados (sem o usuário local). */
  peers: CollabPeer[];
  status: CollabStatus;
}

function snapshotPeers(awareness: AwarenessProtocol.Awareness): CollabPeer[] {
  const localId = awareness.clientID;
  const peers: CollabPeer[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localId) continue;
    const user = (state as { user?: { userId?: string; name?: string; avatarUrl?: string | null } })
      .user;
    peers.push({
      clientId,
      userId: user?.userId,
      name: user?.name,
      avatarUrl: user?.avatarUrl ?? null,
    });
  }
  return peers;
}

/**
 * Presença via awareness: quem está online no documento agora.
 * Atualiza em mudança de awareness (entrar/sair/atualizar cursor).
 */
export function useAwareness(options: UseAwarenessOptions): UseAwarenessResult {
  const { docName } = options;
  const context = useCollaborationContext();
  const session = getOrCreateSession(context, docName);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [status, setStatus] = useState<CollabStatus>(session.getStatus());

  useEffect(() => {
    const update = () => {
      setStatus(session.getStatus());
      if (session.transport?.awareness) {
        setPeers(snapshotPeers(session.transport.awareness));
      }
    };

    update();
    const unsubscribe = session.subscribe(update);

    const awareness = session.transport?.awareness;
    awareness?.on('change', update);

    return () => {
      awareness?.off('change', update);
      unsubscribe();
    };
  }, [session]);

  return { peers, status };
}
