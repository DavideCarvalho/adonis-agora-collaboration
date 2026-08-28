import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationProvider, useCollaborationContext } from '../src/context.js';
import { useCollabDoc } from '../src/hooks/use_collab_doc.js';
import type { DocSession } from '../src/session.js';

afterEach(() => vi.unstubAllGlobals());

describe('server rendering', () => {
  /**
   * The hook used to call `getOrCreateSession` straight from the render body,
   * so every server render mutated the provider's Map and constructed a
   * Y.Doc that no effect would ever start or tear down — the consuming app
   * SSRs every page.
   */
  it('creates no session and no transport during a server render', () => {
    vi.stubGlobal('window', undefined);

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const createTransport = vi.fn();
    let sessions: Map<string, DocSession> | undefined;
    let doc: unknown;
    let status: string | undefined;

    function Probe() {
      sessions = useCollaborationContext().sessions;
      const result = useCollabDoc({ docName: 'researches/42/writing' });
      doc = result.doc;
      status = result.status;
      return null;
    }

    const html = renderToString(
      createElement(
        CollaborationProvider,
        { baseUrl: 'https://api.app', fetchImpl, createTransport: createTransport as never },
        createElement(Probe),
      ),
    );

    expect(html).toBe('');
    expect(sessions?.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
    // The contract still holds: a doc and a status come back.
    expect(doc).toBeTruthy();
    expect(status).toBe('connecting');
  });

  it('still opens a session in the browser', () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ token: 't', wsUrl: '/collaboration', engine: 'yjs' }),
      ) as unknown as typeof fetch;
    let sessions: Map<string, DocSession> | undefined;

    function Probe() {
      sessions = useCollaborationContext().sessions;
      useCollabDoc({ docName: 'researches/42/writing' });
      return null;
    }

    renderToString(
      createElement(
        CollaborationProvider,
        { baseUrl: 'https://api.app', fetchImpl },
        createElement(Probe),
      ),
    );

    // jsdom: `window` exists, so this is the browser branch — proving the
    // assertion above is about the server branch and not a dead hook.
    expect(sessions?.size).toBe(1);
  });
});
