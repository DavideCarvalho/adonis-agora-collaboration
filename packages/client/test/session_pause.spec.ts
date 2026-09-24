import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocSession } from '../src/session.js';
import type { CollaborationClientConfig } from '../src/types.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

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

describe('DocSession pause/resume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pause closes the transport and refuses every implicit reconnect', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/1', makeConfig({ createTransport: factory }));
    const release = session.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);
    created[0]!.setStatus('connected');

    session.pause();
    expect(created[0]!.doc.isDestroyed).toBe(true);

    // What a remount, a new subscriber and the reconnect timer would do.
    void session.start();
    const release2 = session.retain();
    const unsubscribe = session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(created).toHaveLength(1);

    release2();
    unsubscribe();
    release();
    session.destroy();
  });

  it('resume reconnects while a consumer is mounted', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/2', makeConfig({ createTransport: factory }));
    const release = session.retain();
    await vi.advanceTimersByTimeAsync(0);

    session.pause();
    await session.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(2);

    release();
    session.destroy();
  });

  it('resume with nobody mounted stays closed until the next consumer', async () => {
    const { factory, created } = fakeTransportFactory();
    const session = new DocSession('docs/3', makeConfig({ createTransport: factory }));
    const release = session.retain();
    await vi.advanceTimersByTimeAsync(0);
    session.pause();
    release();

    await session.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);

    const again = session.retain();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(2);
    again();
    session.destroy();
  });
});
