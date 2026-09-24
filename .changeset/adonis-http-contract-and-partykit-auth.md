---
"@adonis-agora/collaboration": minor
"@adonis-agora/collaboration-client": patch
---

Fix the built-in routes against a real Adonis app, and the PartyKit driver against a real worker.

- `PATCH`/`DELETE /comments/:id` read the id from `ctx.request.params`, which on Adonis is a
  method: the id was always empty. They now read `ctx.params`.
- `POST /state` (the PartyKit worker snapshot) persisted `raw() ?? empty`, and Adonis leaves
  `application/octet-stream` unread, so it stored a zero-byte document. It now reads the binary
  body from the request stream and answers 400 to an empty body.
- `PartyKitDriver` sent no credential to the worker, whose `onRequest` requires one: every state
  read, version snapshot and restore got a 401. Each call now carries a JWT bound to the room,
  signed with `partykit.jwtSecret` (required; a clear error without it).
- The worker template refused nothing when `COLLAB_JWT_SECRET` was unset — it verified with an
  empty key. It now rejects every token.
- `CollabHttpContext` and the router contract now match Adonis's own `HttpContext` and `Router`
  (checked at compile time), so apps drop their `as unknown as` casts. **Breaking for custom
  contexts:** route params move from `request.params` to `ctx.params`, `request.body()` is no
  longer generic and `request.raw()` returns `unknown`.
- Removed unused imports and a dead helper flagged by Biome.
