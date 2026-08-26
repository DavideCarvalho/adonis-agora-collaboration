import * as A from '@automerge/automerge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import { fetchToken, resolveBaseUrl } from '../rest_client.js';
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
 */

export interface UseAutomergeDocResult<T extends Record<string, unknown>> {
  /** Merged Automerge doc; null until the first server payload arrives. */
  doc: A.Doc<T> | null;
  status: CollabStatus;
  error: Error | null;
  /** Applies a local change and schedules the debounced send. */
  change(cb: A.ChangeFn<T>): void;
}

export interface UseAutomergeDocOptions {
  docName: string;
  /** WebSocket constructor override (tests / polyfills). */
  WebSocketImpl?: typeof WebSocket;
}

const SEND_DEBOUNCE_MS = 200;

export function useAutomergeDoc<T extends Record<string, unknown> = Record<string, unknown>>(
  options: UseAutomergeDocOptions,
): UseAutomergeDocResult<T> {
  const { docName, WebSocketImpl } = options;
  const context = useCollaborationContext();
  const config = context.getConfig();
  // Keeps the shared session lifecycle alive (token endpoint + provider).
  void getOrCreateSession(context, docName);

  const [doc, setDoc] = useState<A.Doc<T> | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const localDocRef = useRef<A.Doc<T> | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const info = await fetchToken(config, docName);
        if (cancelled || info.engine !== 'automerge') {
          if (!cancelled && info.engine !== 'automerge') {
            throw new Error(`useAutomergeDoc requires engine=automerge (got ${info.engine})`);
          }
          return;
        }

        const base = resolveBaseUrl(config);
        const wsUrl = info.wsUrl.startsWith('ws')
          ? `${info.wsUrl}?doc=${encodeURIComponent(docName)}&token=${encodeURIComponent(info.token)}`
          : `${base.replace(/^http/, 'ws')}${info.wsUrl}?doc=${encodeURIComponent(docName)}&token=${encodeURIComponent(info.token)}`;

        const ws = new (WebSocketImpl ?? globalThis.WebSocket)(wsUrl);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
          if (!cancelled) setStatus('connected');
        };

        ws.onmessage = (event) => {
          if (cancelled) return;
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const incoming = A.load<T>(bytes);
          const next = localDocRef.current ? A.merge(localDocRef.current, incoming) : incoming;
          localDocRef.current = next;
          setDoc(next);
        };

        ws.onerror = () => {
          if (!cancelled) setStatus('error');
        };

        ws.onclose = () => {
          if (!cancelled) setStatus('disconnected');
        };
      } catch (cause) {
        if (!cancelled) {
          setStatus('error');
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [docName, config, WebSocketImpl]);

  const change = useCallback(
    (cb: A.ChangeFn<T>) => {
      if (!localDocRef.current) return;
      localDocRef.current = A.change(localDocRef.current, cb);
      setDoc(localDocRef.current);

      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      sendTimerRef.current = setTimeout(() => {
        const ws = wsRef.current;
        if (
          ws?.readyState === (WebSocketImpl ?? globalThis.WebSocket).OPEN &&
          localDocRef.current
        ) {
          ws.send(A.save(localDocRef.current) as unknown as ArrayBuffer);
        }
      }, SEND_DEBOUNCE_MS);
    },
    [WebSocketImpl],
  );

  return { doc, status, error, change };
}
