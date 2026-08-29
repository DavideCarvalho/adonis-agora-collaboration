---
'@adonis-agora/collaboration': patch
---

The Yjs WebSocket never reached Hocuspocus: `attach()` opened sockets nobody listened to

`@hocuspocus/server` 4 does not listen on the socket it is given. `handleConnection` takes a
`WebSocketLike` — `send`, `close`, `readyState`, no events — and returns a `ClientConnection`
that the integrator has to feed with `handleMessage` and `handleClose`, which is exactly what
the package's own `Server` does through its crossws hooks. The Yjs driver called
`handleConnection` and dropped the return value.

What that looked like from outside: the upgrade succeeded, the client reported `connected`, sent
Auth + SyncStep1 + Awareness, and nothing ever came back — with a valid token or a bogus one.
The server never ran `onAuthenticate`, never loaded a document, never stored one; a
`createVersion` from the REST side found no live document and snapshotted an empty one. An app
that "worked" this way for weeks had an empty `collab_documents` table and a history made of
2-byte versions, while every editor opened blank on top of the text the app had saved elsewhere.

`attach()` now wires the three hooks. A new test drives the real path — node HTTP server, the
driver's upgrade handler, the same `HocuspocusProvider` a browser uses — and checks that the
client syncs, that what it types reaches the live document and the storage, that a version is
no longer 2 bytes, and that a bad token gets the socket closed instead of left hanging. Socket
errors are reported through `reportCollaborationError` under the new `transport` scope.
