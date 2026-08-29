---
'@adonis-agora/collaboration-client': minor
'@adonis-agora/collaboration': minor
---

`useAutomergeDoc` reconnects, and two parameters the routes discard are gone

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
been merged on the *current* connection, the Automerge counterpart of the Yjs flag). Disabling the
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
