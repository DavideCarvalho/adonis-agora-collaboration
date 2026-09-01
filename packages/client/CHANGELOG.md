# @adonis-agora/collaboration-client

## 0.8.0

### Minor Changes

- 50016c7: `issueCollaborationToken` and `initialTokens` — the token round-trip in front of the socket, removed.
  
  Opening a document was two serialized requests: `GET /collaboration/token`, and only then the
  WebSocket. Nothing of the text could arrive until both finished — and the first of them went to the
  server that had just rendered the page and already knew the whole answer.
  
  - **Server.** `issueCollaborationToken({ ctx, docName })` (or `{ user, docName }`) issues the
    credential outside the route, for a controller to hand to the page it is rendering. It runs
    `authorize`, resolves the document's engine through the manager and builds `wsUrl` through the
    same function the endpoint calls — a token minted from a controller is byte-for-byte the one the
    route would have issued for that caller. A shortcut that skipped the permission check because it
    was reached from a controller would be a hole, not a shortcut. It throws (`CollabUnauthorizedError`,
    `CollabForbiddenError`) rather than returning a response: in a page controller there is none to
    return, and a render that fails is better than an editor shown to someone who may not read it.
  - **Client.** `<CollaborationProvider initialTokens={{ [docName]: collabToken }}>` and
    `useCollabDoc({ docName, token })`. The transport is built at mount with no HTTP request in front
    of it.
  - **Used once, deliberately.** Reconnects still fetch a fresh token: a credential minted at render
    time is exactly the one that has expired by the time a socket drops, and re-fetching is what
    re-runs `authorize` and makes revocation take effect. A pre-issued token that is malformed or
    already dead is discarded and the session fetches one as it always did — a stale page prop can
    cost the first paint, never the connection.
  - `IssuedToken` (and the `/token` response) gained `expiresAt` for the formats that have an expiry,
    so the client can recognise a dead page prop without opening a socket to find out. The self-hosted
    base64 format still has none: `authorize` re-runs on the handshake, so it is a claim, not a grant
    with a clock.
  
  Nothing changes for an app that passes no token: same request, same order, same behaviour.
- 50016c7: **BREAKING — security.** The self-hosted token is a signed credential now, not an unsigned claim.
  
  `issueToken` used to return `base64(JSON.stringify({ userId }))` for the `yjs` and `automerge`
  engines, and the drivers accepted anything that decoded to an object with a `userId` in it. That is
  not a credential: **a client with no session, no cookie and no login could connect with
  `base64({"userId":"<someone else's id>"})`, be authorized as that person by the app's own
  `authorize` rule, and write into their document.** Verified against the published library, not
  theorised. The token also never expired and could not be revoked, and the WebSocket upgrade runs
  outside the HTTP middleware stack, so no app-side middleware was standing in front of it.
  
  If you run `yjs` or `automerge` with `@adonis-agora/collaboration` ≤ 0.12, treat this as an
  urgent upgrade: any document reachable to an attacker who can guess a user id and a document name
  was readable and writable by them.
  
  **What changed**
  
  - The self-hosted token is an HS256 JWT over `{ userId, docName, user?, iat, exp }`, the same wire
    format the edge already used. The handshake checks the **signature**, the **expiry** (5 minutes,
    `COLLAB_TOKEN_TTL_SECONDS`, matching the edge) and the **document** before `authorize` is
    consulted at all — a token issued for one document does not open another, since the client is the
    one choosing the name it connects to. Signature comparison is constant-time.
  - Both self-hosted drivers verify: `YjsDriver.onAuthenticate` and the `AutomergeDriver` upgrade
    handler (which now answers `4001` for a token that fails verification and `4503` when the server
    has no key).
  - Presence no longer re-decodes the raw token. The Yjs driver publishes the verified identity as the
    connection context and fills the roster from it in `connected`; the old `onConnect` path decoded
    `?token=` a second time, unauthenticated, so a forged name reached the roster even with a checked
    handshake.
  - `verifyPartyKitToken` takes the expected `docName` and enforces it, and the published worker
    template compares the claim against the room it is connecting to. The edge had the same hole: the
    signature was checked, the room was not.
  - `IssuedToken.expiresAt` is now reported for self-hosted tokens too, so a pre-issued page prop can
    be discarded by the client without opening a socket.
  
  **What you have to do**
  
  - Nothing, in a normal AdonisJS app: the signing key is derived from `appKey` (domain-separated), so
    a project with `APP_KEY` set keeps working. Set `tokenSecret` in `config/collaboration.ts` for a
    dedicated key.
  - **If you construct `CollaborationManager` yourself**, pass `tokenSecret` — or run inside a booted
    app so `appKey` is readable. With no key anywhere the library refuses to issue *and* refuses to
    accept tokens (`CollabTokenSecretMissingError`, naming what to set). There is deliberately no flag
    to accept the old format: it would reopen exactly this hole.
  - **If you build a driver directly**, `SelfHostedDriverOptions.tokenSecret` is required.
  - Tokens in the old format stop being accepted. Connected clients reconnect and fetch a new one, so
    the visible cost of upgrading is one reconnect.
  - `parseLegacyToken` is gone. `verifyCollabToken(token, secret, docName)` and
    `verifySelfHostedToken(token, docName, secret?)` replace it; `signCollabToken`,
    `resolveTokenSecret` and `COLLAB_TOKEN_TTL_SECONDS` are exported alongside them.
    `PARTYKIT_TOKEN_TTL_SECONDS` still exists and is the same number.

## 0.7.1

### Patch Changes

- 88c3e5e: Say what ships out of the box, and stop forcing Excalidraw on apps that never render it

  `@excalidraw/excalidraw` was declared a **required** peer while `react` was marked optional —
  backwards on both counts. `ExcalidrawBoard` reaches for Excalidraw through a dynamic
  `await import()`, so an app that never renders a board never loads it; meanwhile `DocSession` and
  the REST client are framework-free, which is why `react` is optional and correctly so. Excalidraw
  is now optional too, and an app using this package for Tiptap or plain text installs neither.

  The docs index gained **What works out of the box** — the four sync engines and where each one's
  socket lives, the three editors with the peer each needs (and why rich text deliberately has no
  adapter), the three storages, and what presence costs. `docs_compile.spec.ts` fails when a shipped
  engine or storage is missing from that table, and parses every page with the compiler the docs site
  uses underneath — an unparseable page took the site's build down once, from a repo that had not
  changed.

## 0.7.0

### Minor Changes

- b44c00e: `useAutomergeDoc` reconnects, and two parameters the routes discard are gone

  **The Automerge hook opened one socket and never rebuilt it.** `ws.onclose` set `status` to
  `'disconnected'` and that was the end of it — the effect's deps (`docName`, `config`,
  `WebSocketImpl`) are all stable, so nothing ever ran again. Meanwhile `change()` went on mutating
  the local document and never sending it: a user typing into a document that had stopped syncing,
  with no state on the hook that could have told them.

  It now reconnects on the same terms as the Yjs `DocSession`, sharing its vocabulary rather than
  growing a second one — `MAX_RECONNECT_ATTEMPTS`, `isPermanentFailure` and the exhausted-budget error
  are now exported from `session.ts` and used by both. A fresh token per attempt, backoff from 1s
  capped at 15s, five attempts, reset by a connection that opens, and an exhausted budget that keeps
  the last real failure as its `cause`. A **permanent** failure is not retried at all: a `4000` /
  `4001` / `4003` close, or a document the server routes to another engine.

  **Changes made while disconnected are not dropped.** The protocol exchanges whole documents, so the
  local doc is its own outbox: the change is applied locally, counted, and the whole saved document is
  written the moment a socket is open again. Two new fields on the result make that visible —
  `pendingChanges` (local changes not yet written to the socket) and `synced` (the server's state has
  been merged on the _current_ connection, the Automerge counterpart of the Yjs flag). Disabling the
  editor on a disconnect is no longer the honest thing to do; showing `pendingChanges` is.

  **Breaking, small:** `userId` is gone from three client signatures, because the routes already
  ignored it in favour of the authenticated caller — `createVersion(config, docName, label)`,
  `createComment(config, input)` and `useComments().create({ space, anchor, body, authorName? })`. It
  was dead on the wire while reading as if it decided who the author was. Drop the argument; nothing
  else changes.

  **`CommentService.get(docName, commentId)`** is new. Authorizing a comment PATCH or DELETE resolved
  its one comment by listing the document's entire thread and filtering — correct, and O(n) in the
  comments, so the check got slower the longer the discussion got. `CollaborationStorage` gains an
  optional `getComment`, implemented by `LucidStorage` as an indexed single-row query; storages
  without it fall back to the old scan, now behind one call.

- b44c00e: Fix the session lifecycle, Excalidraw erase, awareness, and SSR; add a `synced` signal.

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
  status. The docs now recommend gating the _initial_ paint on `synced` and leaving `editable` alone
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

### Patch Changes

- b44c00e: A permanent failure is no longer retried, and no longer loses its reason

  An engine this package has no client for, a document the server refuses, a config that
  cannot build a transport — none of those can succeed on a retry. The session scheduled one
  anyway, and after the fifth attempt `#scheduleReconnect` REPLACED `error` with
  "reconnect: exceeded 5 attempts". So the reader was left holding the one fact they can do
  nothing about, while the one that named the actual problem had been discarded.

  Permanent failures now stop at the first attempt, and when a retryable one does exhaust its
  budget the message carries the last real failure and sets it as `cause`.

## 0.6.0

### Minor Changes

- 2b52ea9: **feat: `useExcalidrawSync` hook + `ExcalidrawBoard` component**

  Nova integração oficial entre o collaboration-client e o Excalidraw, sem depender
  de pacotes de terceiros (`y-excalidraw`).

  - `useExcalidrawSync({ doc, excalidrawAPI })` — liga a API imperativa do
    Excalidraw a um `CollabDoc` (Yjs). Desenho local → Y.Map.set; mudança remota
    → updateScene; montagem → restaura estado salvo.
  - `ExcalidrawBoard({ docName, baseUrl, getHeaders })` — componente pronto, já
    com `CollaborationProvider`, lazy load, CSS, pt-BR.

  Uso:

  ```tsx
  import { ExcalidrawBoard } from "@adonis-agora/collaboration-client";

  <ExcalidrawBoard
    docName="whiteboards/meu-id/canvas"
    baseUrl="https://api.app"
    getHeaders={() => ({ cookie: document.cookie })}
  />;
  ```

  Ou com hook separado:

  ```tsx
  const [api, setApi] = useState(null)
  const { doc } = useCollabDoc({ docName })
  useExcalidrawSync({ doc, excalidrawAPI: api })
  <Excalidraw excalidrawAPI={setApi} />
  ```

## 0.5.3

### Patch Changes

- Fixes three bugs that broke the WebSocket collaboration path:

  **`@adonis-agora/collaboration`**

  - `yjs_driver.ts`: hook `beforeUnloadDocument` persists the Y.Doc to storage before `unloadDocument` destroys it. Without this, F5 on a doc without a pending debounce save loses all edits — Hocuspocus only fires `onStoreDocument` if a debounce was queued, otherwise it calls `unloadDocument` and silently destroys the in-memory Y.Doc.

  **`@adonis-agora/collaboration-client`**

  - `session.ts`: circuit breaker after 5 reconnect attempts. Without this, a failed `/collaboration/token` (e.g. missing DB table, broken auth) sends the client into an infinite retry loop, and each attempt fires Y.Doc updates that the Tiptap `Collaboration` extension listens to — React error #185 (`Maximum update depth exceeded`).
  - `use_collab_doc.ts`: `session.destroy()` in the `useEffect` cleanup. Without this, the Hocuspocus Provider queues callbacks (requestIdleCallback, setTimeout) that access the Y.Doc/Awareness after the component remounts (React 18 StrictMode, navigation) — `Cannot read properties of undefined (reading 'startTime')`, which also leads to React error #185.

## 0.5.0

### Minor Changes

- 4f4a622: Enforce the document permissions, fix the wiring that made declared documents a no-op, and rewrite the docs.

  **Permissions are now enforced, not just reported.** `canWrite: false` makes the sync connection
  read-only (Hocuspocus connection config on Yjs, dropped inbound messages on Automerge) — the client
  still receives every edit, its own are ignored. The built-in REST routes resolve the caller and
  check the matching permission before touching anything: `canRead` to read comments, versions and
  state; `canWrite` to create or restore a version; `canComment` to write a comment. A comment is
  attributed to the authenticated user, and a `userId` in the request body is ignored.

  Apps mounting these routes without auth middleware will now get `401` instead of unauthenticated
  access — set `routes.middleware`.

  **Fixes:**

  - `config.documents` was never forwarded from the provider to the manager, so every `defineDocument`
    declaration was silently ignored — per-document `engine` and `authorize` never applied. The REST
    token endpoint also used only the global `authorize`, which bypassed per-document rules entirely
    on the edge engines.
  - The published migrations created a different schema from the one `LucidStorage` queries
    (`document_name` vs `doc_name`, no `state` column), so running them broke every read.
  - `LucidStorage` discarded version snapshots and `loadVersionSnapshot` returned the current
    document, making `restoreVersion` and `diffVersions` silent no-ops.
  - `lucidStorage()` defaulted to a hard-coded connection name; it now falls back to the app's default
    connection.

  **Client:** `useAwareness` also returns the `awareness` channel, which is what Tiptap's
  `CollaborationCursor` needs to publish the local caret.

## 0.2.0

### Minor Changes

- badb9f7: First release. React hooks for the Adonis collaboration package: `useCollabDoc` (Y.Doc + connection status with per-doc session caching), `useAwareness` (presence peers), `useComments` and `useVersions` (REST-backed anchored comments and version control). Transports are auto-selected from the server engine (Hocuspocus self-hosted or PartyKit edge) and can be overridden via a custom `createTransport` factory.
