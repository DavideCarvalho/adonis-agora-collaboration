---
"@adonis-agora/collaboration": minor
"@adonis-agora/collaboration-client": patch
---

Self-hosted Yjs re-runs `authorize` on open sockets. It used to run only at the handshake, so a user removed from a document kept writing to it until they disconnected. Once a socket's permission is older than the new `reauthorizeEveryMs` option (default 30 s; `0` keeps the old behaviour), the next message is checked before it is applied. Losing `canWrite` makes the socket read-only, losing `canRead` closes it, and an `authorize` that throws makes it read-only until a later check succeeds.

Creating a comment no longer takes `authorName` from the request body: the name, like the `userId`, now comes from the authenticated user. Before, anyone could post a comment under someone else's name. On the client, `authorName` in `useComments().create` is deprecated and ignored.
