---
'@adonis-agora/collaboration-client': minor
---

Fix the session lifecycle, Excalidraw erase, awareness, and SSR; add a `synced` signal.

**Session lifecycle (behaviour change).** `useCollabDoc` used to call `session.destroy()` in its
effect cleanup while the provider's map kept the destroyed session, so a remount (Inertia client
navigation back to the page, React StrictMode) got a corpse whose `start()` short-circuited on the
cached start promise — a dead editor stuck on `connecting` with no error. Sessions are now
**reference counted**: mounting retains, unmounting releases, and the last release tears down the
transport and the reconnect timer but **keeps the `Y.Doc`**, so a remount reconnects onto the same
document. That is also what stops the Hocuspocus provider's queued callbacks from touching a
destroyed doc and driving Tiptap's `Collaboration` extension into React error #185. `destroy()` is
now terminal: it destroys the doc and evicts itself from the provider's map, and
`getOrCreateSession` never returns a destroyed session, and a token response that arrives after a
stop/start cycle is discarded instead of building a second transport on the same document. New on
`DocSession`: `retain()`, `release()`, `stop()`, `refCount`, `isDestroyed`, `synced`,
`getSnapshot()`.

**`synced`.** The transports only mapped Hocuspocus's `status`, so `'connected'` meant "socket
open", not "initial state applied", and gating `editable` on it turned an editor read-only on any
dropped WebSocket. `useCollabDoc`/`useCollabEditor` now return `synced`, wired to Hocuspocus's
`synced` event (and reset when the socket drops); transports that cannot report it fall back to the
status. The docs now recommend gating the *initial* paint on `synced` and leaving `editable` alone
on a disconnect.

**`useExcalidrawSync` accepts what `useCollabDoc` returns.** It was typed `doc: CollabDoc | null`
while `useCollabDoc` returned a `Y.Doc`, so the example in its own docblock did not typecheck and
threw `doc.read is not a function` when forced. It now accepts either, `useCollabDoc` also returns
a `collabDoc` view, and the docblock example is real code.

**Excalidraw erase.** The mount restore and the remote handler were gated on
`scene.elements.length > 0`, which conflates "no document yet" with "an empty board" — select-all +
delete never propagated to other clients and never survived a reload. Both now test whether the key
exists. The last-write-wins limitation of the single-key scene is documented rather than changed.

**`useAwareness`.** The `'change'` listener was bound at effect-run time, before `fetchToken`
resolved, so it subscribed on `null` and presence only refreshed on status transitions; the session
now notifies when the transport appears, and the hook rebinds across every transport rebuild. Adds
`setLocalState` / `setLocalStateField` and a `user` option — without them the `user` field that
`peers` reads could not be populated through the public API — and re-publishes the local state
after a reconnect.

**SSR.** `useCollabDoc`, `useComments`, `useVersions` and `useAutomergeDoc` created a session (and a
`Y.Doc`) in the render body, leaking one per server render; session creation is now lazy and a no-op
off the browser.

**`baseUrl` is optional**, matching `resolveBaseUrl`'s long-standing `location.origin` fallback.

`useCollabEditor` no longer rebuilds its `CollabDoc` wrapper on every render (which re-subscribed
the `Y.Doc` listener each time) and caches its snapshot by document version instead of
`JSON.stringify(scene)`.
