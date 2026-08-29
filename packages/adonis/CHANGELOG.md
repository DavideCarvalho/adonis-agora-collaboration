# @adonis-agora/collaboration

## 0.10.0

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

- b44c00e: Fix route registration, authorize in manual mode, comment permissions, restore semantics, presence wiring and failure visibility.

  **Route registration phase (behaviour change).** The provider registered the built-in REST routes in
  `ready()`, which runs _after_ `Server.boot()` has called `router.commit()` — the router drains its
  pending list there and refuses everything later, so the auto-registered `/collaboration/*` endpoints
  were silently orphaned and answered `404` in a served build while looking perfectly configured.
  Registration moved to `boot()`. The WebSocket attach stays in `ready()`, where it belongs: the node
  HTTP server does not exist before `start()`. A test now drives the real lifecycle order and pins
  both directions.

  **`authorize` in manual mode (behaviour change, security).** `resolveRuntime` read `authorize` only
  from the options, and only the provider passed it — so `collaborationRoutes(router)` called from
  `start/routes.ts` had none, and the absent variable failed in opposite directions in the same file:
  `guard()` fell to its deny literal (`403` for everyone on `/comments`, `/versions`, `/state`) while
  `issueToken` skipped the check entirely (`if (authorize) {…}`), handing any authenticated caller a
  token for any document. Now there is one resolution order — the explicit option, else the manager's
  rule (declared document → global `authorize` → deny), else the app config, else deny — and
  `issueToken` **throws `CollabForbiddenError` when it has no rule** instead of minting. Manual
  registration enforces exactly what the provider and the WebSocket handshake enforce.

  **`collaborationRoutes` is synchronous (API change).** It was `async` only to `await import()` the
  app config, and a `RouteGroup` closes as soon as its callback returns — so it could not be wrapped in
  `router.group(() => …)` and every consuming app wrote a global middleware matched against a
  hardcoded `/collaboration` prefix, which silently stopped protecting anything when `routes.prefix`
  changed. Config is now resolved lazily at request time and the function returns `void`; an existing
  `await collaborationRoutes(...)` still works. `defaultResolveUser` also calls `ctx.auth.check()`
  (or `authenticate()`) before reading `ctx.auth.user`, so a lazily-resolving auth stack produces a
  caller instead of a blanket `401`.

  **Comment mutations are author-or-elevated (behaviour change, security).** `PATCH`/`DELETE
/comments/:id` checked only the document-level `canComment` and then called
  `comments.resolve/remove`, which never look at `userId` — anyone who could comment could resolve or
  delete anyone else's thread. The rule is now explicit and exported as `canMutateComment`: the author
  may always mutate their own comment, anyone else needs `canWrite` on the document. An unknown
  comment id answers `404`.

  **`restoreVersion` honours its contract (behaviour change).** Both drivers did `void restoredBy` and
  overwrote the document without recording what they replaced, in the one operation of a version
  history that most needs to be undoable. A restore now writes the pre-restore state to the history
  first, as a version labelled `restored from #<seq>` attributed to `restoredBy`, and a bad
  `versionId` still fails before anything is written.

  **Presence is actually wired.** The provider built a `RedisPresenceStore` from `redisUrl` and the
  manager wrapped it in a `PresenceService`, but `#buildDriver` never passed `presence` into the driver
  options — the drivers' join/leave were dead code and `listPresence()` returned `[]` forever. It is
  forwarded now, and the driver's bookkeeping is keyed by **socket** instead of by document: the old
  `Map<docName, userId>` held one slot per document, so a second editor overwrote the first and either
  disconnect evicted both. A user with two tabs leaves the roster only when the last one closes. The
  Automerge driver feeds presence too.

  **Storage and authorize failures are visible, and denial is distinct from error.** The library took no
  logger and emitted no events; `onStoreDocument`/`beforeUnloadDocument` called `saveDocument` bare
  inside hooks that swallow throws, and a throw from `authorize` escaped `onAuthenticate` as a generic
  handshake failure — so an outage and a denial looked identical to the client, and an app-side
  database error inside the rule became an unbounded reconnect storm. New: `onCollaborationError`,
  `collaborationEvents`, `setCollaborationLogger` (the provider installs the Adonis logger when it can
  resolve one), and `CollabAuthorizationError`, thrown when the rule could not be evaluated, alongside
  `CollabForbiddenError` for an actual denial.

  **Document names are type-checkable.** `defineConfig` is generic, so the literal keys of `documents`
  survive instead of being widened to `string`, and the new `InferCollabDocumentNames<typeof config>`
  derives the union of declared patterns (`CollabDocumentNameFor` resolves one into a concrete name
  shape). The Assembler codegen hook only ever indexed `app/collaboration/documents`, which apps that
  declare documents inline in `config/collaboration.ts` never create; that limitation is now stated in
  the hook and the docs point at the config route.

  **Also:** `AutomergeDriver.close()` no longer hangs forever on a driver that was never attached
  (`this.wss?.close(cb)` never runs `cb` when there is no server). Docs corrected where they asserted
  the broken behaviour: `authorize` is evaluated **once per connection**, not "on every relevant
  permission change" — revoking access does not drop an open socket; the versions `POST` body has no
  `userId`; and the routes, presence and manual-mode pages describe what the code does.

## 0.9.1

### Patch Changes

- Fixes three bugs that broke the WebSocket collaboration path:

  **`@adonis-agora/collaboration`**

  - `yjs_driver.ts`: hook `beforeUnloadDocument` persists the Y.Doc to storage before `unloadDocument` destroys it. Without this, F5 on a doc without a pending debounce save loses all edits — Hocuspocus only fires `onStoreDocument` if a debounce was queued, otherwise it calls `unloadDocument` and silently destroys the in-memory Y.Doc.

  **`@adonis-agora/collaboration-client`**

  - `session.ts`: circuit breaker after 5 reconnect attempts. Without this, a failed `/collaboration/token` (e.g. missing DB table, broken auth) sends the client into an infinite retry loop, and each attempt fires Y.Doc updates that the Tiptap `Collaboration` extension listens to — React error #185 (`Maximum update depth exceeded`).
  - `use_collab_doc.ts`: `session.destroy()` in the `useEffect` cleanup. Without this, the Hocuspocus Provider queues callbacks (requestIdleCallback, setTimeout) that access the Y.Doc/Awareness after the component remounts (React 18 StrictMode, navigation) — `Cannot read properties of undefined (reading 'startTime')`, which also leads to React error #185.

## 0.9.0

### Minor Changes

- 16b8f4e: Add version retention to the library instead of the docs: `pruneVersions` on the storage SPI, `collaboration:prune` on the CLI.

  **The API.** `CollaborationStorage` gains
  `pruneVersions({ keep, docName?, dryRun? }): Promise<number>` — delete all but the `keep` most
  recent versions and return how many went. `keep` is counted **per document**, so a document
  versioned every minute never evicts the history of one versioned twice a year; `docName` narrows
  the run to one document and `dryRun` counts without deleting. `keep: 0` deletes every version,
  while a negative, fractional or `NaN` `keep` throws instead of silently wiping the history the
  caller meant to keep. Implemented in all three built-in storages, and exposed on the manager as
  `collaboration.current.pruneVersions({ keep })` for scheduling it from code.

  **The command.** `node ace collaboration:prune --keep=20 [--doc=<name>] [--dry-run]` prints how
  many versions it removed. The docs previously told you to run a hand-written
  `DELETE FROM collab_versions` for this; they no longer do.

  **Fixes found by running the Lucid storage against a real Postgres** (a new
  `pnpm test:integration` suite boots a throwaway container and runs the _published_ migrations):

  - `LucidStorage` could not insert anything through a real Lucid connection. `db.connection().from(table)`
    returns the SELECT builder, which has no `insert()` — so saving a document, a version or a comment
    threw `insert is not a function`. The three insert paths now use `.table(...)`, which is the insert
    builder on both Lucid and knex.
  - The lazy `CREATE TABLE IF NOT EXISTS` bootstrap crashed on any app that had run the published
    migrations: knex skips the table but still emits its `CREATE INDEX`, which fails with
    `relation "collab_comments_doc_name_space_index" already exists`. Existing tables are now left
    alone.

  **Custom storages** must implement `pruneVersions` — the custom-storage guide documents the
  per-document contract, including the worked example.

### Patch Changes

- 0a8550a: **fix(lucid): lazy resolve db facade to avoid boot-time race**

  The static `import dbFacade from '@adonisjs/lucid/services/db'` evaluated the
  module before the Lucid provider had registered the facade, so `dbFacade` was
  `undefined` and every `LucidStorage` operation crashed with
  `Cannot read properties of undefined (reading 'connection')`.

  Replaced the static import with a dynamic `import()` inside `knex()`, cached
  in a static field. The first call to any storage method (e.g. `saveDocument`,
  `loadDocument`) resolves the facade lazily — by then the app is fully booted
  and the facade is available.

  The constructor still accepts an optional `db` argument for tests that provide
  a mocked or real connection directly.

## 0.8.0

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

### Patch Changes

- d6e162e: **fix(yjs): seed persisted documents via `onLoadDocument`**

  The YjsDriver wired `onStoreDocument` (persist) but never `onLoadDocument`. Without
  that hook Hocuspocus creates an **empty in-memory Y.Doc on every connection**, so a
  previously saved document always came back blank to clients (and got overwritten on
  the next save). A whiteboard/text doc that was saved would reopen vazio/empty on reload.

  `onLoadDocument` now loads the stored state via the configured storage and seeds the
  doc before serving it (no-op when nothing was persisted yet). Added a regression test
  (`yjs_driver_persist.spec.ts`) covering both paths.

## 0.2.0

### Minor Changes

- badb9f7: New `partykit` engine: edge sync via Cloudflare Workers + Durable Objects. Includes `PartyKitDriver` (HTTP client of the worker's onRequest API), HS256 JWT helpers (`signPartyKitToken`/`verifyPartyKitToken`), worker template published by the new `collaboration:init` command, and `config.partykit.{roomHost,jwtSecret,party,fetchTimeoutMs}`.

  New ace commands: `collaboration:init` (base directories, migrations, PartyKit worker scaffold) and `make:collab-document <name>` (shared per-document types with spaces + anchor kinds). Commands are registered automatically by `configure` via the new `./commands` export.

  Built-in REST endpoints (token, comments CRUD, versions, binary state) are now registered automatically by the provider under `/collaboration`. Set `routes.enabled = false` to take manual control with the new `collaborationRoutes(router, options)` export — supports custom prefix, middleware/guards and a pluggable `resolveUser`. The binary state POST is protected by a shared worker secret.

  AdonisJS v7 codegen integration: an Assembler `init` hook generates `.adonisjs/collaboration/documents.ts`, a typed registry (`CollabDocumentName`, `CollabDocumentDefinition`) refreshed by `node ace codegen` / dev server / build.

  Refactor — seams made real:

  - Comments now flow through a single seam: `manager.comments`. Drivers no longer accept, store or delegate comment operations (12 pass-through methods removed). This also fixes a latent bug where manager and drivers held separate in-memory storage instances when none was configured.
  - New `auth/token` module (`issueToken`, `parseLegacyToken`, `buildWsUrl`, `signPartyKitToken`, `verifyPartyKitToken`) replaces six scattered token implementations; the REST `/token` endpoint now enforces `config.authorize` (403 on denial) — previously it was bypassed off the WS path.
  - Drivers take narrow dependency objects (`SelfHostedDriverOptions`, `PartyKitDriverOptions`) instead of the whole `CollaborationConfig`.
  - Removed dead `PresenceService` (+ ioredis dependency) and the duplicated REST controller/routes stubs — manual mode uses `collaborationRoutes()` directly.

  New engines and client surfaces:

  - `partyserver` engine: client transport (`PartyServerCollabTransport`) for the self-hosted Cloudflare Workers stack via `y-partyserver/provider`; token issuance treats it like the partykit edge engine.
  - Automerge on the client: new `useAutomergeDoc(docName)` hook speaking the server driver's binary protocol directly (initial full save, debounced local saves, CRDT merge) — intentionally outside the Y.Doc-centric hooks, since Automerge docs cannot back Tiptap/awareness.

## 0.1.1

### Patch Changes

- 30b5ec1: Initial release — CRDT collaboration for AdonisJS (Yjs/Hocuspocus + Automerge drivers), LucidStorage, generic anchored comments (CommentAnchor), Redis presence.
