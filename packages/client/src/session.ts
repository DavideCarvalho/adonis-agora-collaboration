import * as Y from 'yjs';
import { fetchToken } from './rest_client.js';
import { defaultTransportFactory } from './transports/index.js';
import type {
  CollaborationClientConfig,
  CollabStatus,
  CollabTokenInfo,
  CollabTransport,
} from './types.js';

export const MAX_RECONNECT_DELAY_MS = 15_000;
/**
 * Circuit breaker: depois de MAX_RECONNECT_ATTEMPTS falhas consecutivas no
 * fetchToken (e.g. banco sem as tabelas esperadas, auth quebrada), paramos
 * de tentar e marcamos o status como 'error'. Sem isso, o client fica
 * num loop infinito de retry e cada tentativa dispara updates no Y.Doc
 * que o Tiptap `Collaboration` extension escuta — em setups que ligam
 * o editor com `forceUpdate` na mudança, isso vira React error #185
 * (Maximum update depth exceeded) e trava a página.
 */
export const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Whether a failure can never succeed on a retry.
 *
 * Reconnecting is for a network that dropped. An engine this package has no client for, a
 * document the server refuses, or a config that cannot produce a transport fails the same
 * way five times and then reports "exceeded 5 attempts" — which names nothing and buries
 * what did.
 *
 * Matched on the message rather than an error class because these arrive from four
 * different places (this file, `fetchToken`, the transport factory, `useAutomergeDoc`)
 * and unifying their error types is a wider change than this fix.
 *
 * Shared with the Automerge hook on purpose: both paths reconnect, and two dialects of
 * "this can never work" would drift.
 */
export function isPermanentFailure(error: Error): boolean {
  return /has no client-side hooks yet|requires engine=|jwtSecret is required|\bforbidden\b|\b40[13]\b/i.test(
    error.message,
  );
}

/**
 * The error a caller is left with when the reconnect budget runs out.
 *
 * Keeps WHY it kept failing: replacing the cause with "exceeded N attempts" leaves the
 * reader the one fact they can do nothing about, having discarded the one they could.
 * Shared with the Automerge hook so an exhausted budget reads the same on both paths.
 */
export function reconnectExhausted(lastFailure: Error | null): Error {
  return new Error(
    `reconnect: exceeded ${MAX_RECONNECT_ATTEMPTS} attempts${
      lastFailure ? ` (last failure: ${lastFailure.message})` : ''
    }`,
    lastFailure ? { cause: lastFailure } : undefined,
  );
}

/** Immutable snapshot consumed by `useSyncExternalStore`. */
export interface DocSessionSnapshot {
  status: CollabStatus;
  error: Error | null;
  /** True once the server's initial state has been applied to the doc. */
  synced: boolean;
}

/** Minimal shape of the provider's session map, for self-eviction on destroy. */
export interface DocSessionRegistry {
  get(docName: string): DocSession | undefined;
  delete(docName: string): unknown;
}

export interface DocSessionOptions {
  registry?: DocSessionRegistry;
}

/**
 * Session for a single document: fetches the ephemeral token, creates the
 * transport and exposes an observable snapshot store (consumed via
 * useSyncExternalStore). One session per docName per provider.
 *
 * ## Lifecycle
 *
 * The session is **reference counted**. Every hook that mounts calls
 * {@link retain} and releases on unmount; the first retain starts the token
 * fetch, and the last {@link release} calls {@link stop}, which tears the
 * transport down (socket closed, reconnect timer cleared) but **keeps the
 * `Y.Doc` alive**. Remounting retains again and rebuilds the transport with
 * a fresh token against the same document.
 *
 * That split matters: the Hocuspocus provider queues callbacks
 * (requestIdleCallback, setTimeout) that touch the `Y.Doc` after teardown.
 * Destroying the doc on unmount made those callbacks throw
 * `Cannot read properties of undefined (reading 'startTime')`, which drives
 * Tiptap's Collaboration extension into React error #185. `stop()` destroys
 * the provider — which is what actually stops the socket and the timers —
 * and leaves the doc, so nothing can observe a destroyed document.
 *
 * {@link destroy} is the terminal call: it also destroys the `Y.Doc` and
 * evicts the session from the provider's map, so a destroyed session is
 * never handed back to a component.
 *
 * Ephemeral tokens expire, so on `disconnected` (after having connected at
 * least once) the transport is torn down and rebuilt with a fresh token,
 * using exponential backoff.
 */
export class DocSession {
  readonly docName: string;
  readonly doc: Y.Doc;

  #config: CollaborationClientConfig;
  #status: CollabStatus = 'connecting';
  #error: Error | null = null;
  #transport: CollabTransport | undefined;
  #listeners = new Set<() => void>();
  #startPromise: Promise<void> | undefined;
  #destroyed = false;
  #detached = false;
  #refs = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #generation = 0;
  #engine: string | undefined;
  #registry: DocSessionRegistry | undefined;
  #snapshot: DocSessionSnapshot | undefined;

  constructor(docName: string, config: CollaborationClientConfig, options?: DocSessionOptions) {
    this.docName = docName;
    this.#config = config;
    this.#registry = options?.registry;
    this.doc = new Y.Doc();
  }

  get transport(): CollabTransport | undefined {
    return this.#transport;
  }

  get error(): Error | null {
    return this.#error;
  }

  /** Engine informado pelo server no token (yjs | automerge | ...). */
  get engine(): string | undefined {
    return this.#engine;
  }

  /** True after {@link destroy} — such a session can never reconnect. */
  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** How many mounted consumers are holding this session open. */
  get refCount(): number {
    return this.#refs;
  }

  /**
   * True once the server's initial state has been applied to the doc.
   *
   * `status === 'connected'` only means the socket is open. Transports that
   * cannot tell the two apart (partykit/partyserver, custom test doubles)
   * fall back to reporting `connected` as synced, so this is never *less*
   * informative than the status.
   */
  get synced(): boolean {
    const transport = this.#transport;
    if (!transport) return false;
    return transport.isSynced?.() ?? transport.getStatus() === 'connected';
  }

  getStatus(): CollabStatus {
    return this.#status;
  }

  /**
   * Referentially stable snapshot: a new object is only minted when a field
   * actually changed, so `useSyncExternalStore` does not re-render on every
   * transport event.
   */
  getSnapshot(): DocSessionSnapshot {
    const previous = this.#snapshot;
    const next: DocSessionSnapshot = {
      status: this.#status,
      error: this.#error,
      synced: this.synced,
    };
    if (
      previous &&
      previous.status === next.status &&
      previous.error === next.error &&
      previous.synced === next.synced
    ) {
      return previous;
    }
    this.#snapshot = next;
    return next;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    // Idempotent: start only fires once (first subscriber).
    void this.start();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Marks one mounted consumer. Returns the matching release, so a hook can
   * `return session.retain()` straight out of an effect.
   */
  retain(): () => void {
    this.#refs += 1;
    void this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /** Drops one consumer; the last one out calls {@link stop}. */
  release(): void {
    if (this.#refs === 0) return;
    this.#refs -= 1;
    if (this.#refs === 0) this.stop();
  }

  /** Idempotent — token + transport created a single time per generation. */
  start(): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    this.#detached = false;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  /**
   * Detaches the transport without killing the document: socket closed,
   * reconnect timer cleared, next {@link start} rebuilds from a fresh token.
   * The `Y.Doc` and its contents survive, so a remount resumes instead of
   * starting from an empty document.
   */
  stop(): void {
    if (this.#destroyed || this.#detached) return;
    this.#detached = true;
    this.#generation += 1;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#transport?.destroy();
    this.#transport = undefined;
    this.#startPromise = undefined;
    this.#attempt = 0;
    this.#setStatus('connecting', null);
    this.#notify();
  }

  async #start(): Promise<void> {
    // A stop()/start() pair (StrictMode remount) can land while this token
    // request is still in flight. Without the generation check the stale
    // request would come back and build a *second* transport on the same doc.
    const generation = this.#generation;
    const stale = () => this.#destroyed || this.#detached || generation !== this.#generation;
    try {
      const info = await fetchToken(this.#config, this.docName);
      this.#engine = info.engine;
      if (stale()) return;

      if (info.engine === 'automerge') {
        throw new Error(
          "engine 'automerge' has no client-side hooks yet — use engine yjs or partykit",
        );
      }

      const factory = this.#config.createTransport ?? defaultTransportFactory;
      const transport = factory(
        info as CollabTokenInfo & { engine: string },
        this.doc,
        this.docName,
      );

      this.#transport = transport;
      transport.subscribe(() => {
        if (!this.#transport) return;
        this.#applyStatus(this.#transport.getStatus());
        // `synced` flips without the status changing, and so does the
        // awareness object — always wake subscribers.
        this.#notify();
      });
      this.#applyStatus(transport.getStatus());
      // The transport (and its awareness channel) only exists now. Status may
      // not have changed ('connecting' → 'connecting'), so #setStatus would
      // stay silent and nothing would ever bind to awareness.
      this.#notify();
    } catch (error) {
      if (stale()) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#setStatus('error', failure);
      // A PERMANENT failure is not retried. Retrying an unsupported engine, a rejected
      // document or a malformed config cannot succeed, and the retry is not free: after the
      // last attempt `#scheduleReconnect` replaces `error` with "exceeded N attempts", so
      // the message the reader is finally shown is the one that explains nothing, and the
      // one that named the actual problem is gone.
      if (isPermanentFailure(failure)) return;
      this.#scheduleReconnect();
    }
  }

  #applyStatus(status: CollabStatus): void {
    if (status === 'connected') {
      // Successful connection resets the backoff window.
      this.#attempt = 0;
    }
    this.#setStatus(status);

    if (status === 'disconnected' && !this.#destroyed && !this.#detached) {
      this.#scheduleReconnect();
    }
  }

  #setStatus(status: CollabStatus, error: Error | null = this.#error): void {
    const changed = status !== this.#status || error !== this.#error;
    this.#status = status;
    this.#error = error;
    if (changed) this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /**
   * Tears the current transport down and rebuilds it with a fresh token.
   * Backoff doubles per failed attempt and caps at {@link MAX_RECONNECT_DELAY_MS}.
   */
  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#destroyed || this.#detached) return;
    if (this.#attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.#setStatus('error', reconnectExhausted(this.#error));
      return;
    }

    const delay = Math.min(1000 * 2 ** this.#attempt, MAX_RECONNECT_DELAY_MS);
    this.#attempt += 1;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#destroyed || this.#detached) return;

      this.#transport?.destroy();
      this.#transport = undefined;
      this.#startPromise = undefined;
      this.#setStatus('connecting');
      void this.start();
    }, delay);
  }

  /**
   * Terminal teardown: destroys the transport **and** the `Y.Doc`, and evicts
   * the session from the provider's map so it is never handed back. Use
   * {@link stop} for "nobody is looking at this right now".
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#refs = 0;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#transport?.destroy();
    this.#transport = undefined;
    this.doc.destroy();
    if (this.#registry?.get(this.docName) === this) {
      this.#registry.delete(this.docName);
    }
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }
}
