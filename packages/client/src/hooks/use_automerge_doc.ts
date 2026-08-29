import * as A from '@automerge/automerge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollaborationContext } from '../context.js';
import { fetchToken, resolveBaseUrl } from '../rest_client.js';
import {
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  isPermanentFailure,
  reconnectExhausted,
} from '../session.js';
import type { CollabStatus } from '../types.js';

/**
 * Automerge client — deliberately OUTSIDE the Y.Doc-centric
 * CollabTransport seam. Tiptap/awareness need a Y.Doc; Automerge documents
 * are a different data structure, so this ships its own small hook instead
 * of forcing both worlds behind one interface.
 *
 * Wire protocol mirrors the server's AutomergeDriver:
 *  1. ws `${wsUrl}?doc=<name>&token=<token>` (token via fetchToken)
 *  2. server sends the full `A.save(doc)` binary on connect
 *  3. client sends its full saved doc after local changes (debounced)
 *  4. incoming binaries are merged into the local doc and re-broadcast by
 *     the server to the other peers
 *
 * ## Reconnection
 *
 * The socket is rebuilt on a drop, with a fresh token and the same backoff
 * budget as {@link DocSession} — the two paths share
 * {@link MAX_RECONNECT_ATTEMPTS}, {@link isPermanentFailure} and
 * {@link reconnectExhausted} rather than growing two dialects of the same
 * reasoning. A permanent failure (a `4003` close, an engine that is not
 * Automerge) is NOT retried: retrying it cannot succeed, and the retry would
 * end by replacing the message that named the problem with "exceeded N
 * attempts", which names nothing.
 *
 * Local changes made while the socket is down are **not lost**. Automerge's
 * full-document exchange makes the local doc its own outbox: the change is
 * applied locally, {@link UseAutomergeDocResult.pendingChanges} counts it, and
 * the whole saved document is written the moment a socket is open again. The
 * count is exposed so a UI can say "3 unsaved changes" instead of pretending
 * everything is fine.
 */

export interface UseAutomergeDocResult<T extends Record<string, unknown>> {
  /** Merged Automerge doc; null until the first server payload arrives. */
  doc: A.Doc<T> | null;
  status: CollabStatus;
  error: Error | null;
  /**
   * True once the server's state has been merged on the CURRENT connection —
   * the Automerge counterpart of `DocSessionSnapshot.synced`. `status ===
   * 'connected'` only means the socket is open; this means the two sides have
   * actually exchanged the document. Goes back to false on a drop.
   */
  synced: boolean;
  /**
   * Local changes applied but not yet written to the socket. Non-zero while
   * disconnected, and back to zero once the reconnected socket has been sent
   * the document. Surface it — a user typing into a document that stopped
   * syncing deserves to know.
   */
  pendingChanges: number;
  /** Applies a local change and schedules the debounced send. */
  change(cb: A.ChangeFn<T>): void;
}

export interface UseAutomergeDocOptions {
  docName: string;
  /** WebSocket constructor override (tests / polyfills). */
  WebSocketImpl?: typeof WebSocket;
}

const SEND_DEBOUNCE_MS = 200;

/**
 * Close codes the AutomergeDriver uses for an answer, not an outage.
 *
 * `4000` (no doc) and `4001` (no token, or one that does not parse) are config problems — the token is
 * minted fresh on every attempt, so a socket that refuses it will refuse the next one
 * too. `4003` is `authorize` saying no. `4503` ("authorization unavailable") and `4500`
 * ("could not open the document") are deliberately NOT here: the server distinguishes
 * "you may not" from "we could not tell", and so does this client.
 */
const PERMANENT_CLOSE_CODES = new Set([4000, 4001, 4003]);

export function useAutomergeDoc<T extends Record<string, unknown> = Record<string, unknown>>(
  options: UseAutomergeDocOptions,
): UseAutomergeDocResult<T> {
  const { docName, WebSocketImpl } = options;
  const context = useCollaborationContext();
  const config = context.getConfig();
  // No DocSession here: the Automerge path owns its own socket, and creating
  // a Yjs session in the render body only leaked one Y.Doc per server render.

  const [doc, setDoc] = useState<A.Doc<T> | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [synced, setSynced] = useState(false);
  const [pendingChanges, setPendingChanges] = useState(0);

  const localDocRef = useRef<A.Doc<T> | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingRef = useRef(0);
  /** Installed by the connection effect, which owns the socket. */
  const flushRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const Impl = WebSocketImpl ?? globalThis.WebSocket;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    /**
     * Bumped on every connect. A token request still in flight when the socket
     * is rebuilt (or the component unmounts) comes back to a dead generation
     * and is discarded, instead of opening a second socket on the same doc.
     */
    let generation = 0;
    /** The last real failure, kept so an exhausted budget can name it. */
    let lastFailure: Error | null = null;

    const fail = (failure: Error): void => {
      lastFailure = failure;
      setStatus('error');
      setError(failure);
    };

    const flush = (): void => {
      if (socket?.readyState !== Impl.OPEN || !localDocRef.current) return;
      socket.send(A.save(localDocRef.current) as unknown as ArrayBuffer);
      pendingRef.current = 0;
      setPendingChanges(0);
    };
    flushRef.current = flush;

    const scheduleReconnect = (): void => {
      if (reconnectTimer || disposed) return;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('error');
        setError(reconnectExhausted(lastFailure));
        return;
      }

      const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (disposed) return;
        setStatus('connecting');
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      generation += 1;
      const mine = generation;
      const stale = () => disposed || mine !== generation;

      try {
        const info = await fetchToken(config, docName);
        if (stale()) return;
        if (info.engine !== 'automerge') {
          throw new Error(`useAutomergeDoc requires engine=automerge (got ${info.engine})`);
        }

        const base = resolveBaseUrl(config);
        const query = `?doc=${encodeURIComponent(docName)}&token=${encodeURIComponent(info.token)}`;
        const wsUrl = info.wsUrl.startsWith('ws')
          ? `${info.wsUrl}${query}`
          : `${base.replace(/^http/, 'ws')}${info.wsUrl}${query}`;

        const ws = new Impl(wsUrl);
        ws.binaryType = 'arraybuffer';
        socket = ws;

        ws.onopen = () => {
          if (stale()) return;
          // A connection that opened resets the backoff window, exactly as
          // `DocSession#applyStatus` does on 'connected'.
          attempt = 0;
          lastFailure = null;
          setStatus('connected');
          setError(null);
          // Everything typed while the socket was down goes out now. The local
          // doc IS the outbox: this protocol sends whole documents.
          if (pendingRef.current > 0) flush();
        };

        ws.onmessage = (event) => {
          if (stale()) return;
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const incoming = A.load<T>(bytes);
          const next = localDocRef.current ? A.merge(localDocRef.current, incoming) : incoming;
          localDocRef.current = next;
          setDoc(next);
          setSynced(true);
        };

        ws.onerror = () => {
          if (stale()) return;
          // A browser socket fires error and then close; `onclose` is what
          // decides between retrying and giving up. This only records the
          // reason, so an exhausted budget has something to name.
          lastFailure = new Error('websocket error');
        };

        ws.onclose = (event) => {
          if (stale()) return;
          socket = null;
          setSynced(false);
          const code = (event as CloseEvent | undefined)?.code;
          const reason = (event as CloseEvent | undefined)?.reason;
          const failure = new Error(
            `websocket closed${code ? ` (${code}${reason ? `: ${reason}` : ''})` : ''}`,
          );

          if (code !== undefined && PERMANENT_CLOSE_CODES.has(code)) {
            fail(failure);
            return;
          }

          lastFailure = failure;
          setStatus('disconnected');
          scheduleReconnect();
        };
      } catch (cause) {
        if (stale()) return;
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        fail(failure);
        // A PERMANENT failure is not retried: an unsupported engine or a rejected
        // document fails the same way five times, and the retry then buries the
        // message that explained it under "exceeded N attempts".
        if (isPermanentFailure(failure)) return;
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      disposed = true;
      generation += 1;
      flushRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      socket?.close();
      socket = null;
    };
  }, [docName, config, WebSocketImpl]);

  const change = useCallback((cb: A.ChangeFn<T>) => {
    if (!localDocRef.current) return;
    localDocRef.current = A.change(localDocRef.current, cb);
    setDoc(localDocRef.current);
    pendingRef.current += 1;
    setPendingChanges(pendingRef.current);

    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(() => {
      sendTimerRef.current = undefined;
      // A no-op while the socket is down — the change stays counted in
      // `pendingChanges` and goes out on the next `onopen`.
      flushRef.current?.();
    }, SEND_DEBOUNCE_MS);
  }, []);

  return { doc, status, error, synced, pendingChanges, change };
}
