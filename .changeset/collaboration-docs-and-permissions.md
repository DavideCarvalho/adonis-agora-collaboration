---
'@adonis-agora/collaboration': minor
'@adonis-agora/collaboration-client': minor
---

Enforce the document permissions, fix the wiring that made declared documents a no-op, and rewrite the docs.

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
