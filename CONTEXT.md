# CONTEXT.md

Domain vocabulary for `adonis-collaboration`. Keep names exact across code, docs and reviews.

## Domain terms

- **Document** — a collaborative CRDT document identified by name (`researches/42/writing`). Names contain slashes; they travel via query/body, never path params.
- **Engine** — the sync backend: `yjs` | `automerge` | `partykit` | `partyserver`.
- **Driver** — adapter owning one engine's transport + version control. Connected only through the driver registry.
- **Anchored comment** — comment bound to an `Anchor` (`text-range` | `canvas-object` | `timestamp`) inside a document `Space`.
- **Version** — named snapshot marker in a document history.
- **Session** (client) — per-docName Y.Doc + transport lifecycle owned by the provider.

## Seams (where behaviour can change without editing in place)

- **Driver registry** (`collaboration_manager.ts`) — engine ↔ Driver adapters.
- **CollaborationStorage** — host-app persistence injected into drivers/manager.
- **auth/token** (`src/auth/token.ts`) — issue/verify credentials; enforces `authorize` on both WS handshake and REST `/token`. Two wire formats: JWT (partykit) and legacy base64 (self-hosted).
- **Comments** live ONLY at `manager.comments` — drivers never touch them.
- **REST surface** — built-in handlers in `routes.ts`; auto-registered by the provider, or manual via `collaborationRoutes(router)`.
- **CollabTransport** (client) — Hocuspocus / PartyKit / PartyServer adapters behind one interface (Y.Doc-centric).
- **useAutomergeDoc** (client) — separate seam: Automerge documents cannot back a Y.Doc, so they get their own hook instead of forcing both worlds into CollabTransport.

## Decided NOT to do (do not re-suggest without new evidence)

- Presence service removed: edge engines own presence in the worker; local Redis presence had no writers. Revisit only with a concrete multi-instance self-hosted requirement.
