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
- Automerge engine: one wire protocol. The whole-document mode and the `sync=changes` / `CHANGES_ACK` handshake are removed (`CHANGES_ACK` is no longer exported from `@adonis-agora/collaboration/drivers/automerge`); the client gets the document once and both sides exchange change chunks. Upgrade `@adonis-agora/collaboration` and `@adonis-agora/collaboration-client` together.
- `@adonis-agora/collaboration-client`: a pre-issued token's expiry is read from `expiresAt` only; the JWT `exp` is no longer decoded. Pass the `expiresAt` that `issueCollaborationToken` returns.
- `@adonis-agora/collaboration`: the `appKey` fallback reads `appKey` only as a `Secret` (`new Secret(env.get('APP_KEY'))`); a plain string is ignored.
- Both packages require Node.js 24 or newer.
