import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { CollabTokenInfo, CollabTransport } from '../types.js';
import { normalizeStatus } from './normalize_status.js';

/**
 * Transporte pra engine `yjs` self-hosted: Hocuspocus rodando embutido no
 * server Adonis (upgrade no path /collaboration).
 */

type StatusListener = () => void;

export class HocuspocusCollabTransport implements CollabTransport {
  readonly doc: Y.Doc;
  private provider: HocuspocusProvider;
  private status: import('../types.js').CollabStatus = 'connecting';
  private synced = false;
  private listeners = new Set<StatusListener>();

  constructor(info: CollabTokenInfo, doc: Y.Doc, docName: string) {
    this.doc = doc;

    // wsUrl do server é o path (/collaboration); converte pra ws(s)://
    // usando o origin da página quando relativo.
    const url = info.wsUrl.startsWith('ws')
      ? info.wsUrl
      : `${globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'}://${globalThis.location?.host ?? 'localhost'}${info.wsUrl}`;

    this.provider = new HocuspocusProvider({
      url,
      name: docName,
      document: doc,
      token: info.token,
    });

    this.provider.on('status', ({ status }: { status: string }) => {
      this.status =
        status === 'connected'
          ? 'connected'
          : status === 'disconnected'
            ? 'disconnected'
            : 'connecting';
      // A dropped socket un-syncs the document: the next connection has to
      // replay the initial sync before the local state is authoritative
      // again. Without this, `synced` would latch true forever after the
      // first handshake and gating `editable` on it would be a lie.
      if (this.status !== 'connected') this.synced = false;
      this.emit();
    });

    // 'connected' means the socket is open; 'synced' means the server's
    // initial state has actually been applied to the Y.Doc. Gating an editor
    // on the former shows an empty document for a beat and then merges the
    // user's keystrokes into the incoming state.
    this.provider.on('synced', ({ state }: { state: boolean }) => {
      this.synced = state;
      this.emit();
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get awareness() {
    return this.provider.awareness;
  }

  getStatus(): import('../types.js').CollabStatus {
    return this.status;
  }

  isSynced(): boolean {
    return this.synced;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    void this.provider.destroy();
  }
}
