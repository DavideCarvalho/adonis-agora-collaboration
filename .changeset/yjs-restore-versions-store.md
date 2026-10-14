---
'@adonis-agora/collaboration': minor
---

Fix Yjs version restore, stop shipping every snapshot when listing versions, skip rewriting unchanged documents, and add document compaction.

- **`restoreVersion` left the document empty.** It cleared the `default` fragment and re-applied the version's update, but when the version comes from the document's own history (the normal case) its items are already known to the live doc — Yjs treats them as integrated, so nothing came back. The fragment is now copied as new items; other root types keep the previous merge.
- **`LucidStorage.listVersions` selected every column**, so each listing — and each `createVersion`, which lists to find the next `seq` — pulled every snapshot from the database just to drop it (tens of MB for a long history). It now selects only the metadata.
- **Unchanged documents are no longer written back.** `beforeUnloadDocument`/`onStoreDocument` rewrote the full state every time the last connection closed, even for a server-side reader that changed nothing. The driver now remembers what storage holds (sha1 of the update, set on load and on every save) and skips identical writes.
- **New: `compactDocument` / `node ace collaboration:compact --doc=<name>`.** Rewrites a stored Yjs document without its deleted history, verifies it reads back identical, and keeps the old state as a `before compaction` version. Refuses a document that is open in the process or has anyone in presence. Exposed as the optional `CompactingDriver` capability (`supportsCompaction`).
