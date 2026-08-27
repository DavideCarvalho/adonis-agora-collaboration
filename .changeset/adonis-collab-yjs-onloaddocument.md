---
'@adonis-agora/collaboration': patch
---

**fix(yjs): seed persisted documents via `onLoadDocument`**

The YjsDriver wired `onStoreDocument` (persist) but never `onLoadDocument`. Without
that hook Hocuspocus creates an **empty in-memory Y.Doc on every connection**, so a
previously saved document always came back blank to clients (and got overwritten on
the next save). A whiteboard/text doc that was saved would reopen vazio/empty on reload.

`onLoadDocument` now loads the stored state via the configured storage and seeds the
doc before serving it (no-op when nothing was persisted yet). Added a regression test
(`yjs_driver_persist.spec.ts`) covering both paths.