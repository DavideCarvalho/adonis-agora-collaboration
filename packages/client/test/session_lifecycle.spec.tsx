import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollaborationProvider,
  getOrCreateSession,
  useCollaborationContext,
} from '../src/context.js';
import { useCollabDoc } from '../src/hooks/use_collab_doc.js';
import type { DocSession } from '../src/session.js';
import { DocSession as DocSessionClass } from '../src/session.js';
import type { CollaborationClientConfig } from '../src/types.js';
import { fakeTransportFactory } from './helpers/fake_transport.js';

afterEach(() => vi.unstubAllGlobals());

const tokenFetch = () =>
  vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
    ) as unknown as typeof fetch;

/**
 * One provider, two independent consumers of the same document that can be
 * mounted and unmounted without remounting the provider — which is what an
 * Inertia client navigation (or StrictMode) does to a page.
 */
function harness(docName: string) {
  const { factory, created } = fakeTransportFactory();
  const fetchImpl = tokenFetch();
  let sessions: Map<string, DocSession> | undefined;
  let seen: ReturnType<typeof useCollabDoc> | undefined;

  function Spy() {
    sessions = useCollaborationContext().sessions;
    return null;
  }
  function ProbeA() {
    seen = useCollabDoc({ docName });
    return null;
  }
  function ProbeB() {
    useCollabDoc({ docName });
    return null;
  }

  const tree = (a: boolean, b: boolean) =>
    createElement(
      CollaborationProvider,
      { baseUrl: 'https://api.app', createTransport: factory, fetchImpl },
      createElement(Spy, { key: 'spy' }),
      a ? createElement(ProbeA, { key: 'a' }) : null,
      b ? createElement(ProbeB, { key: 'b' }) : null,
    );

  const view = render(tree(true, false));

  return {
    created,
    session: () => sessions?.get(docName),
    get result() {
      return seen;
    },
    setMounted: (a: boolean, b: boolean) => view.rerender(tree(a, b)),
  };
}

describe('session lifecycle', () => {
  /**
   * The cleanup used to call `session.destroy()`, which flipped `#destroyed`
   * and destroyed the Y.Doc while the provider's Map kept the corpse. The
   * remount got that corpse back and `start()` short-circuited on the cached
   * `#startPromise`, so the editor stayed dead — `connecting` forever, and
   * no error to show for it.
   */
  it('remounting after the last unmount reconnects on the same live document', async () => {
    const h = harness('docs/lifecycle-1');

    await waitFor(() => expect(h.created).toHaveLength(1));
    const session = h.session();
    const doc = session?.doc;
    expect(session).toBeDefined();
    act(() => h.created[0]?.setStatus('connected'));
    await waitFor(() => expect(h.result?.status).toBe('connected'));

    // Last consumer unmounts: the socket goes, the document stays.
    act(() => h.setMounted(false, false));
    expect(session?.refCount).toBe(0);
    expect(session?.isDestroyed).toBe(false);
    expect(doc?.isDestroyed).toBe(false);
    expect(h.created[0]?.doc.isDestroyed).toBe(true);

    // Remount: a live session that actually rebuilds a transport.
    act(() => h.setMounted(true, false));
    await waitFor(() => expect(h.created).toHaveLength(2));
    expect(h.session()).toBe(session);
    expect(h.result?.doc).toBe(doc);
    act(() => h.created[1]?.setStatus('connected'));
    await waitFor(() => expect(h.result?.status).toBe('connected'));
  });

  it('two consumers of one document do not tear each other down', async () => {
    const h = harness('docs/lifecycle-2');
    act(() => h.setMounted(true, true));

    await waitFor(() => expect(h.created).toHaveLength(1));
    const session = h.session();
    expect(session?.refCount).toBe(2);
    act(() => h.created[0]?.setStatus('connected'));
    await waitFor(() => expect(h.result?.status).toBe('connected'));

    // One unmounts — the other keeps the same transport, still connected.
    act(() => h.setMounted(true, false));
    expect(session?.refCount).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.doc.isDestroyed).toBe(false);
    expect(h.result?.status).toBe('connected');

    act(() => h.setMounted(false, false));
    expect(session?.refCount).toBe(0);
    expect(h.created[0]?.doc.isDestroyed).toBe(true);
  });

  /**
   * A stop()/start() pair lands while the first token request is still in
   * flight (exactly what StrictMode's mount → unmount → mount does). The
   * stale response must not build a second transport over the same document.
   */
  it('discards a token response that arrives after a stop/start cycle', async () => {
    const { factory, created } = fakeTransportFactory();
    let resolveToken: (() => void) | undefined;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveToken = resolve;
      });
      return Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' });
    }) as unknown as typeof fetch;

    const session = new DocSessionClass('docs/race', {
      baseUrl: 'https://api.app',
      createTransport: factory,
      fetchImpl,
    });

    const release = session.retain();
    await Promise.resolve();
    expect(created).toHaveLength(0);

    release(); // stop() — the first token request is still pending
    const releaseAgain = session.retain(); // start() again

    resolveToken?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveToken?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toHaveLength(1);
    releaseAgain();
    session.destroy();
  });

  it('never hands back a destroyed session', () => {
    const config: CollaborationClientConfig = { baseUrl: 'https://api.app' };
    const context = { getConfig: () => config, sessions: new Map<string, DocSession>() };

    const first = getOrCreateSession(context, 'docs/corpse');
    first.destroy();

    // destroy() evicts itself from the provider's map…
    expect(context.sessions.has('docs/corpse')).toBe(false);
    // …and even a corpse forced back in is replaced rather than reused.
    context.sessions.set('docs/corpse', first);
    const second = getOrCreateSession(context, 'docs/corpse');
    expect(second).not.toBe(first);
    expect(second.isDestroyed).toBe(false);
  });
});

/**
 * A failure that cannot succeed on a retry must not be retried, and the reason must survive.
 *
 * Both halves were broken together. An unsupported engine threw, the session set `error`
 * and scheduled a reconnect anyway; five attempts later `#scheduleReconnect` REPLACED the
 * message with "exceeded 5 attempts" — so the reader was left with the one fact they can do
 * nothing about, and the one naming the actual problem was gone.
 */
describe('a permanent failure', () => {
  it('is not retried, and keeps the reason it failed', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ engine: 'automerge', wsUrl: 'wss://api.app', token: 't' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        ) as unknown as typeof fetch;

      const session = new DocSessionClass('doc/permanent', {
        baseUrl: 'https://api.app',
        fetchImpl,
      } as unknown as CollaborationClientConfig);

      await session.start();
      expect(session.getStatus()).toBe('error');
      expect(session.error?.message).toMatch(/no client-side hooks yet/);

      // Nothing was scheduled: advancing past the whole backoff window changes nothing.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(session.error?.message).toMatch(/no client-side hooks yet/);
      expect(session.error?.message).not.toMatch(/exceeded/);
    } finally {
      vi.useRealTimers();
    }
  });
});
