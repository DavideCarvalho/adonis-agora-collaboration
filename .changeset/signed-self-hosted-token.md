---
'@adonis-agora/collaboration': minor
'@adonis-agora/collaboration-client': minor
---

**BREAKING — security.** The self-hosted token is a signed credential now, not an unsigned claim.

`issueToken` used to return `base64(JSON.stringify({ userId }))` for the `yjs` and `automerge`
engines, and the drivers accepted anything that decoded to an object with a `userId` in it. That is
not a credential: **a client with no session, no cookie and no login could connect with
`base64({"userId":"<someone else's id>"})`, be authorized as that person by the app's own
`authorize` rule, and write into their document.** Verified against the published library, not
theorised. The token also never expired and could not be revoked, and the WebSocket upgrade runs
outside the HTTP middleware stack, so no app-side middleware was standing in front of it.

If you run `yjs` or `automerge` with `@adonis-agora/collaboration` ≤ 0.12, treat this as an
urgent upgrade: any document reachable to an attacker who can guess a user id and a document name
was readable and writable by them.

**What changed**

- The self-hosted token is an HS256 JWT over `{ userId, docName, user?, iat, exp }`, the same wire
  format the edge already used. The handshake checks the **signature**, the **expiry** (5 minutes,
  `COLLAB_TOKEN_TTL_SECONDS`, matching the edge) and the **document** before `authorize` is
  consulted at all — a token issued for one document does not open another, since the client is the
  one choosing the name it connects to. Signature comparison is constant-time.
- Both self-hosted drivers verify: `YjsDriver.onAuthenticate` and the `AutomergeDriver` upgrade
  handler (which now answers `4001` for a token that fails verification and `4503` when the server
  has no key).
- Presence no longer re-decodes the raw token. The Yjs driver publishes the verified identity as the
  connection context and fills the roster from it in `connected`; the old `onConnect` path decoded
  `?token=` a second time, unauthenticated, so a forged name reached the roster even with a checked
  handshake.
- `verifyPartyKitToken` takes the expected `docName` and enforces it, and the published worker
  template compares the claim against the room it is connecting to. The edge had the same hole: the
  signature was checked, the room was not.
- `IssuedToken.expiresAt` is now reported for self-hosted tokens too, so a pre-issued page prop can
  be discarded by the client without opening a socket.

**What you have to do**

- Nothing, in a normal AdonisJS app: the signing key is derived from `appKey` (domain-separated), so
  a project with `APP_KEY` set keeps working. Set `tokenSecret` in `config/collaboration.ts` for a
  dedicated key.
- **If you construct `CollaborationManager` yourself**, pass `tokenSecret` — or run inside a booted
  app so `appKey` is readable. With no key anywhere the library refuses to issue *and* refuses to
  accept tokens (`CollabTokenSecretMissingError`, naming what to set). There is deliberately no flag
  to accept the old format: it would reopen exactly this hole.
- **If you build a driver directly**, `SelfHostedDriverOptions.tokenSecret` is required.
- Tokens in the old format stop being accepted. Connected clients reconnect and fetch a new one, so
  the visible cost of upgrading is one reconnect.
- `parseLegacyToken` is gone. `verifyCollabToken(token, secret, docName)` and
  `verifySelfHostedToken(token, docName, secret?)` replace it; `signCollabToken`,
  `resolveTokenSecret` and `COLLAB_TOKEN_TTL_SECONDS` are exported alongside them.
  `PARTYKIT_TOKEN_TTL_SECONDS` still exists and is the same number.
