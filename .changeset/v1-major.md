---
"@adonis-agora/collaboration": major
"@adonis-agora/collaboration-client": major
---

1.0. See [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/collaboration/migrating-to-1.0).

**Breaking changes**

- `@adonis-agora/collaboration-client`: `useComments().create` no longer accepts `authorName`. The author, name included, is the authenticated user (`resolveUser`). Drop the field from the call.
- `@adonis-agora/collaboration-client`: `createComment(config, input)` no longer accepts `authorName`, for the same reason.
- `@adonis-agora/collaboration`: `signPartyKitToken` and `verifyPartyKitToken` are removed, from the package root and from `@adonis-agora/collaboration/drivers/partykit`. Use `signCollabToken` and `verifyCollabToken` (same arguments, same result) with `partykit.jwtSecret` as the key.
- `@adonis-agora/collaboration`: `PARTYKIT_TOKEN_TTL_SECONDS` is removed. Use `COLLAB_TOKEN_TTL_SECONDS` (the same value, 300).
- Both packages require Node.js 24 or newer.
