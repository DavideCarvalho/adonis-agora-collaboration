---
'@adonis-agora/collaboration-client': patch
'@adonis-agora/collaboration': patch
---

Say what ships out of the box, and stop forcing Excalidraw on apps that never render it

`@excalidraw/excalidraw` was declared a **required** peer while `react` was marked optional —
backwards on both counts. `ExcalidrawBoard` reaches for Excalidraw through a dynamic
`await import()`, so an app that never renders a board never loads it; meanwhile `DocSession` and
the REST client are framework-free, which is why `react` is optional and correctly so. Excalidraw
is now optional too, and an app using this package for Tiptap or plain text installs neither.

The docs index gained **What works out of the box** — the four sync engines and where each one's
socket lives, the three editors with the peer each needs (and why rich text deliberately has no
adapter), the three storages, and what presence costs. `docs_compile.spec.ts` fails when a shipped
engine or storage is missing from that table, and parses every page with the compiler the docs site
uses underneath — an unparseable page took the site's build down once, from a repo that had not
changed.
