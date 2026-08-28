import * as Y from 'yjs';
import { fetchToken } from './rest_client.js';
import { defaultTransportFactory } from './transports/index.js';
import type {
  CollabStatus,
  CollabTokenInfo,
  CollabTransport,
  CollaborationClientConfig,
} from './types.js';

const MAX_RECONNECT_DELAY_MS = 15_000;
/**
 * Circuit breaker: depois de MAX_RECONNECT_ATTEMPTS falhas consecutivas no
 * fetchToken (e.g. banco sem as tabelas esperadas, auth quebrada), paramos
 * de tentar e marcamos o status como 'error'. Sem isso, o client fica
 * num loop infinito de retry e cada tentativa dispara updates no Y.Doc
 * que o Tiptap `Collaboration` extension escuta — em setups que ligam
 * o editor com `forceUpdate` na mudança, isso vira React error #185
 * (Maximum update depth exceeded) e trava a página.
 */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Session for a single document: fetches the ephemeral token, creates the
 * transport and exposes an observable status store (consumed via
 * useSyncExternalStore). One session per docName per provider — it
 * outlives individual hook unmounts.
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
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #engine: string | undefined;

  constructor(docName: string, config: CollaborationClientConfig) {
    this.docName = docName;
    this.#config = config;
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

  getStatus(): CollabStatus {
    return this.#status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    // Idempotent: start only fires once (first subscriber).
    void this.start();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Idempotent — token + transport created a single time per generation. */
  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    try {
      const info = await fetchToken(this.#config, this.docName);
      this.#engine = info.engine;
      if (this.#destroyed) return;

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
      });
      this.#applyStatus(transport.getStatus());
    } catch (error) {
      this.#setStatus('error', error instanceof Error ? error : new Error(String(error)));
      this.#scheduleReconnect();
    }
  }

  #applyStatus(status: CollabStatus): void {
    if (status === 'connected') {
      // Successful connection resets the backoff window.
      this.#attempt = 0;
    }
    this.#setStatus(status);

    if (status === 'disconnected' && !this.#destroyed) {
      this.#scheduleReconnect();
    }
  }

  #setStatus(status: CollabStatus, error: Error | null = this.#error): void {
    const changed = status !== this.#status || error !== this.#error;
    this.#status = status;
    this.#error = error;
    if (changed) {
      for (const listener of this.#listeners) listener();
    }
  }

  /**
   * Tears the current transport down and rebuilds it with a fresh token.
   * Backoff doubles per failed attempt and caps at {@link MAX_RECONNECT_DELAY_MS}.
   */
  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#destroyed) return;
    if (this.#attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.#setStatus(
        'error',
        new Error(`reconnect: exceeded ${MAX_RECONNECT_ATTEMPTS} attempts`),
      );
      return;
    }

    const delay = Math.min(1000 * 2 ** this.#attempt, MAX_RECONNECT_DELAY_MS);
    this.#attempt += 1;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#destroyed) return;

      this.#transport?.destroy();
      this.#transport = undefined;
      this.#startPromise = undefined;
      this.#setStatus('connecting');
      void this.start();
    }, delay);
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#transport?.destroy();
    this.doc.destroy();
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }
}
