# @adonis-agora/collaboration

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
