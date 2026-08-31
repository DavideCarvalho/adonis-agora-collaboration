---
'@adonis-agora/collaboration': minor
---

Infer `authorize` params from the document pattern key.

`defineConfig` is now generic over the keys of `documents`: the entry under
`'whiteboards/:boardId'` receives `params: { boardId: string }`, and `params.id` there is a compile
error instead of an `undefined` at runtime. A plain object literal is all an entry needs — the
`defineDocument<{ id: string }>()` type parameter was redundant when it matched the key and silently
wrong when it did not.

`defineDocument` stays as an identity helper for declarations that live away from their key; an
explicit `P` that contradicts the key it is attached to is now rejected at the config.
`DocumentParams<Pattern>`, `CollabDocuments<Pattern>` and `CollaborationAppConfigFor<Pattern>` are
exported for callers that want the shapes on their own.
