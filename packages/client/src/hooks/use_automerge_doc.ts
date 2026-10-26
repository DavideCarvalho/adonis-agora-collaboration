import * as A from '@automerge/automerge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollaborationContext } from '../context.js';
import { fetchToken, resolveBaseUrl } from '../rest_client.js';
import {
  isPermanentFailure,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
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
 *  1. ws `${wsUrl}?doc=<name>&token=<token>&sync=changes` (token via fetchToken)
 *  2. a server that exchanges change chunks answers with the
 *     {@link CHANGES_ACK} text frame; then every server sends the full
 *     `A.save(doc)` binary
 *  3. after local changes (debounced) the client sends the changes the server
 *     lacks (`A.saveSince`) once acknowledged, else its whole saved doc
 *  4. incoming binaries — change chunks or whole docs — are applied with
 *     `A.loadIncremental`; the server forwards what was new to the other peers
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
 * whatever the server's state lacks is written as soon as a reconnected socket
 * has delivered that state. The
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

/** Text frame a server sends when this socket may exchange change chunks. */
const CHANGES_ACK = 'automerge-sync:changes';

function sameHeads(a: A.Heads, b: A.Heads): boolean {
  return a.length === b.length && a.every((hash, index) => hash === b[index]);
}

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
    /** The current socket's server acknowledged change chunks. */
    let sendsChanges = false;
    /** The current socket has delivered the server's state. */
    let stateReceived = false;
    /** Heads the server is known to hold on the current socket. */
    let serverHeads: A.Heads = [];

    const fail = (failure: Error): void => {
      lastFailure = failure;
      setStatus('error');
      setError(failure);
    };

    /**
     * Sends what the server lacks: the changes since {@link serverHeads} to a
     * server that acknowledged chunks, the whole saved doc to any other. Waits
     * for the server's state, which is where a reconnect catches up.
     */
    const flush = (): void => {
      const local = localDocRef.current;
      if (socket?.readyState !== Impl.OPEN || !local || !stateReceived) return;
      if (sendsChanges) {
        const heads = A.getHeads(local);
        if (!sameHeads(heads, serverHeads)) {
          socket.send(A.saveSince(local, serverHeads) as unknown as ArrayBuffer);
          serverHeads = heads;
        }
      } else {
        socket.send(A.save(local) as unknown as ArrayBuffer);
      }
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
      sendsChanges = false;
      stateReceived = false;
      serverHeads = [];

      try {
        const info = await fetchToken(config, docName);
        if (stale()) return;
        if (info.engine !== 'automerge') {
          throw new Error(`useAutomergeDoc requires engine=automerge (got ${info.engine})`);
        }

        const base = resolveBaseUrl(config);
        const query = `?doc=${encodeURIComponent(docName)}&token=${encodeURIComponent(info.token)}&sync=changes`;
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
        };

        ws.onmessage = (event) => {
          if (stale()) return;
          if (typeof event.data === 'string') {
            if (event.data === CHANGES_ACK) sendsChanges = true;
            return;
          }
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const current = localDocRef.current;

          if (!stateReceived) {
            // The server's whole state. Whatever the local doc holds beyond it
            // — typed while disconnected, or sent on a socket that dropped —
            // goes out now: the local doc is the outbox.
            const incoming = A.load<T>(bytes);
            const next = current ? A.merge(current, incoming) : incoming;
            localDocRef.current = next;
            stateReceived = true;
            serverHeads = A.getHeads(incoming);
            setDoc(next);
            setSynced(true);
            if (sameHeads(A.getHeads(next), serverHeads)) {
              pendingRef.current = 0;
              setPendingChanges(0);
            } else {
              flush();
            }
            return;
          }

          const next = current ? A.loadIncremental(current, bytes) : A.load<T>(bytes);
          localDocRef.current = next;
          // With nothing left unsent, the server holds everything this doc holds.
          if (pendingRef.current === 0) serverHeads = A.getHeads(next);
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
