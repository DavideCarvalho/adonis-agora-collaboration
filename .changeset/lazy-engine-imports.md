---
"@adonis-agora/collaboration": patch
---

Load heavy engine dependencies on first use instead of at import time. `@automerge/automerge` now loads when an automerge driver first opens a document, `@hocuspocus/transformer` (Tiptap + ProseMirror) when a document's text or a diff is first computed, and `@hocuspocus/server` when the yjs driver first attaches to the HTTP server. Importing the package root or its provider drops from ~10.5 MB to ~3.9 MB of heap (and ~100 ms of module evaluation) in every process that never opens a document — ace commands, queue workers, and web pods until the first collaboration request. No API change.
