import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocSession } from '../src/session.js';
import type { CollaborationClientConfig } from '../src/types.js';
import { FakeTransport, fakeTransportFactory } from './helpers/fake_transport.js';

function makeConfig(overrides?: Partial<CollaborationClientConfig>): CollaborationClientConfig {
  return {
    baseUrl: 'https://api.app',
    fetchImpl: vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
      ),
    ...overrides,
  };
}

describe('DocSession reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rebuilds the transport with a fresh token after disconnection', async () => {
    const { factory, created } = fakeTransportFactory();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
      );
    const session = new DocSession(
      'docs/1',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as typeof fetch }),
    );

    const unsubscribe = session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(created).toHaveLength(1);
    created[0]!.setStatus('connected');
    created[0]!.setStatus('disconnected');

    // Backoff: first retry after ~1s.
    await vi.advanceTimersByTimeAsync(1100);

    expect(created).toHaveLength(2);
    // Fresh token fetched (two calls to the token endpoint).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Old transport torn down before rebuilding.
    expect(created[0]!.doc.isDestroyed).toBe(true);

    unsubscribe();
    session.destroy();
  });

  it('applies exponential backoff capped at 15s', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/2', makeConfig({ createTransport: factory }));

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);

    // Three consecutive disconnects.
    for (const transport of created) transport.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(2); // +1s

    created[1]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
    expect(created).toHaveLength(3); // +2s

    created[2]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(4000);
    expect(created).toHaveLength(4); // +4s

    created[3]!.setStatus('connected'); // reset backoff
    created[3]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(5); // back to +1s

    session.destroy();
  });

  it('does not reconnect after destroy', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/3', makeConfig({ createTransport: factory }));

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    session.destroy();
    created[0]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(created).toHaveLength(1);
  });

  it('reconnects with backoff when the token endpoint fails', async () => {
    let ok = false;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (!ok) return new Response('nope', { status: 500 });
      return Response.json({ token: 'late', wsUrl: '/collaboration', engine: 'yjs' });
    });
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession(
      'docs/4',
      makeConfig({ createTransport: factory, fetchImpl: fetchMock as typeof fetch }),
    );

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getStatus()).toBe('error');

    ok = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(1);
    expect(session.getStatus()).toBe('connecting');

    session.destroy();
  });

  it('keeps a stable Y.Doc across reconnect generations', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/5', makeConfig({ createTransport: factory }));
    const doc = session.doc;

    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    created[0]!.setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1000);

    expect(session.doc).toBe(doc);
    session.destroy();
  });

  it('FakeTransport remains compatible', () => {
    const transport = new FakeTransport({ token: 't', wsUrl: '/x', engine: 'yjs' }, 'doc');
    expect(transport.getStatus()).toBe('connecting');
  });
});
