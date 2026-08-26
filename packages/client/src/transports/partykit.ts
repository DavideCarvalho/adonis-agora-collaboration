import * as PartyKitModule from 'y-partykit/provider';
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import type { CollabStatus, CollabTokenInfo, CollabTransport } from '../types.js';
import { normalizeStatus } from './normalize_status.js';

/**
 * Transporte pra engine `partykit`: conecta direto ao room no worker
 * Cloudflare (origin separado do Adonis). Mesma wire format y-protocols,
 * provider próprio.
 *
 * Nota: o d.ts de y-partykit@0.0.33 só declara o construtor como default
 * export, mas o build ESM exporta nomeado — tipamos aqui o mínimo que
 * usamos pra não depender da divergência.
 */

interface PartyKitProviderLike {
  awareness: AwarenessProtocol.Awareness;
  destroy(): void;
  on(event: string, handler: (arg: unknown) => void): void;
}

interface PartyKitCtor {
  new (
    host: string,
    room: string,
    doc?: Y.Doc,
    options?: {
      party?: string;
      protocol?: 'ws' | 'wss';
      params?: Record<string, string>;
    },
  ): PartyKitProviderLike;
}

const YPartyKitProviderCtor = (PartyKitModule as unknown as { YPartyKitProvider: PartyKitCtor })
  .YPartyKitProvider;

export class PartyKitCollabTransport implements CollabTransport {
  readonly doc: Y.Doc;
  private provider: InstanceType<PartyKitCtor>;
  private status: CollabStatus = 'connecting';
  private listeners = new Set<() => void>();

  constructor(info: CollabTokenInfo, doc: Y.Doc, docName: string) {
    this.doc = doc;

    // wsUrl esperado: <host>/parties/<party>/<room> ou host simples.
    const url = new URL(
      info.wsUrl.startsWith('http') ? info.wsUrl : `https://${info.wsUrl}`,
      globalThis.location?.origin ?? 'https://localhost',
    );

    const partyFromPath = /^\/parties\/([^/]+)\//.exec(url.pathname);
    const party = partyFromPath?.[1];
    const room = partyFromPath
      ? decodeURIComponent(url.pathname.replace(/^\/parties\/[^/]+\//, ''))
      : decodeURIComponent(url.pathname.replace(/^\//, ''));

    const protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws' : 'wss';

    this.provider = new YPartyKitProviderCtor(url.host, room.length > 0 ? room : docName, doc, {
      ...(party ? { party } : {}),
      protocol: protocol === 'ws' ? ('ws' as const) : ('wss' as const),
      params: { token: info.token },
    });

    const emit = () => {
      for (const listener of this.listeners) listener();
    };

    this.provider.on('status', (arg) => {
      const status = (arg as { status?: string } | undefined)?.status ?? '';
      this.status =
        status === 'connected'
          ? 'connected'
          : status === 'disconnected'
            ? 'disconnected'
            : 'connecting';
      emit();
    });
    this.provider.on('connection-error', () => {
      this.status = 'error';
      emit();
    });
    this.provider.on('connection-close', () => {
      if (this.status !== 'error') {
        this.status = 'disconnected';
        emit();
      }
    });
  }

  get awareness(): AwarenessProtocol.Awareness {
    return this.provider.awareness;
  }

  getStatus(): CollabStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.provider.destroy();
  }
}
