import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import type { CollabPeer, CollabStatus } from '../types.js';

/** Identity published into the awareness `user` field, which peers read. */
export interface CollabLocalUser {
  userId?: string;
  name?: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
}

export interface UseAwarenessOptions {
  docName: string;
  /**
   * Sua identidade, publicada no campo `user` do awareness local — é
   * exatamente o campo que `peers` lê nos outros clientes. Sem isso ninguém
   * vê seu nome/avatar (o snapshot de todo mundo vem com `user: undefined`).
   */
  user?: CollabLocalUser | null;
}

export interface UseAwarenessResult {
  /** Peers conectados (sem o usuário local). */
  peers: CollabPeer[];
  status: CollabStatus;
  /**
   * The document's raw awareness channel, or null before the transport
   * connects (and on engines that have none).
   *
   * `peers` covers rendering an avatar stack; this is for editor extensions
   * that drive their own remote carets from awareness — Tiptap's
   * CollaborationCursor takes a `provider` and reads `provider.awareness`,
   * so it needs the object rather than a snapshot.
   */
  awareness: AwarenessProtocol.Awareness | null;
  /**
   * Publishes the local awareness state (cursor, selection, identity).
   *
   * The value is remembered and re-published on every transport rebuild, so
   * a reconnect does not silently drop you from everyone else's presence
   * list. Pass `null` to go invisible.
   */
  setLocalState(state: Record<string, unknown> | null): void;
  /** Publishes/overwrites a single field of the local awareness state. */
  setLocalStateField(field: string, value: unknown): void;
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
 *
 * ```tsx
 * const { peers, setLocalState } = useAwareness({
 *   docName: 'researches/42/writing',
 *   user: { userId: me.id, name: me.name, avatarUrl: me.avatarUrl },
 * })
 * ```
 */
export function useAwareness(options: UseAwarenessOptions): UseAwarenessResult {
  const { docName, user } = options;
  const context = useCollaborationContext();
  const isBrowser = typeof window !== 'undefined';
  const session = useMemo(
    () => (isBrowser ? getOrCreateSession(context, docName) : null),
    [context, docName, isBrowser],
  );

  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [status, setStatus] = useState<CollabStatus>(() => session?.getStatus() ?? 'connecting');
  const [awareness, setAwareness] = useState<AwarenessProtocol.Awareness | null>(null);

  /** Last published local state — re-applied to every new awareness channel. */
  const localStateRef = useRef<Record<string, unknown> | null>(null);

  const setLocalState = useCallback(
    (state: Record<string, unknown> | null) => {
      localStateRef.current = state;
      session?.transport?.awareness?.setLocalState(state);
    },
    [session],
  );

  const setLocalStateField = useCallback(
    (field: string, value: unknown) => {
      const next = { ...(localStateRef.current ?? {}), [field]: value };
      localStateRef.current = next;
      session?.transport?.awareness?.setLocalState(next);
    },
    [session],
  );

  useEffect(() => {
    if (!session) return;

    // The transport only exists after fetchToken resolves, so reading
    // `session.transport.awareness` once at effect-run time bound the
    // 'change' listener to `null` and presence only ever refreshed on a
    // status transition. Rebind whenever the channel appears or is replaced
    // (every reconnect builds a new transport, and a new Awareness with it).
    let bound: AwarenessProtocol.Awareness | null = null;

    const update = () => {
      setStatus(session.getStatus());
      const next = session.transport?.awareness ?? null;
      if (next !== bound) {
        bound?.off('change', update);
        bound = next;
        bound?.on('change', update);
        // Re-publish the local identity onto the fresh channel.
        if (bound && localStateRef.current !== null) {
          bound.setLocalState(localStateRef.current);
        }
        setAwareness(next);
      }
      setPeers(next ? snapshotPeers(next) : []);
    };

    update();
    const unsubscribe = session.subscribe(update);
    const release = session.retain();

    return () => {
      bound?.off('change', update);
      unsubscribe();
      release();
    };
  }, [session]);

  // Serialized identity: consumers pass an inline object literal, so
  // depending on `user` itself would re-publish on every render.
  const userKey = user === undefined ? undefined : JSON.stringify(user ?? null);
  useEffect(() => {
    if (userKey === undefined) return;
    setLocalStateField('user', JSON.parse(userKey) as CollabLocalUser | null);
  }, [userKey, setLocalStateField]);

  return { peers, status, awareness, setLocalState, setLocalStateField };
}
