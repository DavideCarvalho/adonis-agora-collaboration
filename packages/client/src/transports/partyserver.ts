import * as PartyServerModule from 'y-partyserver/provider';
import type * as AwarenessProtocol from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import type { CollabStatus, CollabTokenInfo, CollabTransport } from '../types.js';

/**
 * Transport for the self-hosted Cloudflare Workers stack (`partyserver` +
 * `y-partyserver`). Same y-protocols wire format as the PartyKit edge
 * engine; different package and default deployment origin.
 *
 * The provider's d.ts declares the class as a default export while the ESM
 * build exports it named — we access it by name with a local structural
 * type so we don't depend on that divergence.
 */

interface PartyServerProviderLike {
  awareness: AwarenessProtocol.Awareness;
  destroy(): void;
  on(event: string, handler: (arg: unknown) => void): void;
}

interface PartyServerCtor {
  new (
    host: string,
    room: string,
    doc?: Y.Doc,
    options?: {
      party?: string;
      prefix?: string;
      protocol?: 'ws' | 'wss';
      params?: Record<string, string>;
      connect?: boolean;
    },
  ): PartyServerProviderLike;
}

const YProviderCtor =
  (PartyServerModule as unknown as { YProvider?: PartyServerCtor; default?: PartyServerCtor })
    .YProvider ?? (PartyServerModule as unknown as { default: PartyServerCtor }).default;

export class PartyServerCollabTransport implements CollabTransport {
  readonly doc: Y.Doc;
  private provider: InstanceType<PartyServerCtor>;
  private status: CollabStatus = 'connecting';
  private listeners = new Set<() => void>();

  constructor(info: CollabTokenInfo, doc: Y.Doc, docName: string) {
    if (!YProviderCtor) {
      throw new Error('y-partyserver/provider did not export a provider class');
    }
    this.doc = doc;

    // wsUrl expected: <host>/parties/<party>/<room> or a bare host.
    const url = new URL(
      info.wsUrl.startsWith('http') ? info.wsUrl : `https://${info.wsUrl}`,
      globalThis.location?.origin ?? 'https://localhost',
    );

    const partyFromPath = /^\/parties\/([^/]+)\//.exec(url.pathname);
    const party = partyFromPath?.[1];
    const room = partyFromPath
      ? decodeURIComponent(url.pathname.replace(/^\/parties\/[^/]+\//, ''))
      : decodeURIComponent(url.pathname.replace(/^\//, ''));

    this.provider = new YProviderCtor(url.host, room.length > 0 ? room : docName, doc, {
      ...(party ? { party } : {}),
      protocol:
        url.protocol === 'http:' || url.protocol === 'ws:' ? ('ws' as const) : ('wss' as const),
      params: { token: info.token },
    });

    const emit = () => {
      for (const listener of this.listeners) listener();
    };

    this.provider.on('status', (arg) => {
      const raw = (arg as { status?: string } | undefined)?.status;
      this.status =
        raw === 'connected' ? 'connected' : raw === 'disconnected' ? 'disconnected' : 'connecting';
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
