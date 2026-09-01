---
'@adonis-agora/collaboration': minor
'@adonis-agora/collaboration-client': minor
---

`issueCollaborationToken` and `initialTokens` — the token round-trip in front of the socket, removed.

Opening a document was two serialized requests: `GET /collaboration/token`, and only then the
WebSocket. Nothing of the text could arrive until both finished — and the first of them went to the
server that had just rendered the page and already knew the whole answer.

- **Server.** `issueCollaborationToken({ ctx, docName })` (or `{ user, docName }`) issues the
  credential outside the route, for a controller to hand to the page it is rendering. It runs
  `authorize`, resolves the document's engine through the manager and builds `wsUrl` through the
  same function the endpoint calls — a token minted from a controller is byte-for-byte the one the
  route would have issued for that caller. A shortcut that skipped the permission check because it
  was reached from a controller would be a hole, not a shortcut. It throws (`CollabUnauthorizedError`,
  `CollabForbiddenError`) rather than returning a response: in a page controller there is none to
  return, and a render that fails is better than an editor shown to someone who may not read it.
- **Client.** `<CollaborationProvider initialTokens={{ [docName]: collabToken }}>` and
  `useCollabDoc({ docName, token })`. The transport is built at mount with no HTTP request in front
  of it.
- **Used once, deliberately.** Reconnects still fetch a fresh token: a credential minted at render
  time is exactly the one that has expired by the time a socket drops, and re-fetching is what
  re-runs `authorize` and makes revocation take effect. A pre-issued token that is malformed or
  already dead is discarded and the session fetches one as it always did — a stale page prop can
  cost the first paint, never the connection.
- `IssuedToken` (and the `/token` response) gained `expiresAt` for the formats that have an expiry,
  so the client can recognise a dead page prop without opening a socket to find out. The self-hosted
  base64 format still has none: `authorize` re-runs on the handshake, so it is a claim, not a grant
  with a clock.

Nothing changes for an app that passes no token: same request, same order, same behaviour.
