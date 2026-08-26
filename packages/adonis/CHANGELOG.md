# @adonis-agora/collaboration

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
