---
"@adonis-agora/collaboration-client": minor
---

Upstream two changes the Entre Textos app carried as a local patch.

- `DocSession.pause()` / `resume()`: latches the transport closed while keeping the `Y.Doc`, so
  no remount, `retain()`, subscriber or reconnect timer reopens it until `resume()` — which
  reconnects only when a consumer is still mounted. `stop()` alone is undone by the next mount.
- **Breaking:** `useAutomergeDoc` moves off the root entry to
  `@adonis-agora/collaboration-client/automerge`. Re-exported from the root, Automerge's WASM was
  loaded eagerly by every Yjs-only app during hydration.
