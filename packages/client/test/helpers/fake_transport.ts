import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type {
  CollabStatus,
  CollabTokenInfo,
  CollabTransport,
  TransportFactory,
} from '../src/types.js';

/** Transporte fake controlado por testes. */
export class FakeTransport implements CollabTransport {
  readonly doc: Y.Doc;
  readonly listeners = new Set<() => void>();
  private current: CollabStatus = 'connecting';

  constructor(
    public readonly info: CollabTokenInfo,
    public readonly docName: string,
  ) {
    this.doc = new Y.Doc();
  }

  get awareness() {
    return undefined;
  }

  getStatus(): CollabStatus {
    return this.current;
  }

  setStatus(status: CollabStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

export function fakeTransportFactory(): {
  factory: TransportFactory;
  created: FakeTransport[];
} {
  const created: FakeTransport[] = [];
  return {
    created,
    factory: (info, doc, docName) => {
      const transport = new FakeTransport(info, docName);
      void doc;
      created.push(transport);
      return transport;
    },
  };
}

describe('FakeTransport', () => {
  it('notifies subscribers on status change', () => {
    const { factory, created } = fakeTransportFactory();
    const transport = factory(
      { token: 't', wsUrl: '/collaboration', engine: 'yjs' },
      new Y.Doc(),
      'doc',
    );
    expect(created).toHaveLength(1);

    let notified = 0;
    transport.subscribe(() => notified++);
    (transport as FakeTransport).setStatus('connected');
    expect(notified).toBe(1);
    expect(transport.getStatus()).toBe('connected');
  });
});
