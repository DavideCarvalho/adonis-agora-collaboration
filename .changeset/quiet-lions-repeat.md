---
'@adonis-agora/collaboration': minor
---

Fix route registration, authorize in manual mode, comment permissions, restore semantics, presence wiring and failure visibility.

**Route registration phase (behaviour change).** The provider registered the built-in REST routes in
`ready()`, which runs *after* `Server.boot()` has called `router.commit()` — the router drains its
pending list there and refuses everything later, so the auto-registered `/collaboration/*` endpoints
were silently orphaned and answered `404` in a served build while looking perfectly configured.
Registration moved to `boot()`. The WebSocket attach stays in `ready()`, where it belongs: the node
HTTP server does not exist before `start()`. A test now drives the real lifecycle order and pins
both directions.

**`authorize` in manual mode (behaviour change, security).** `resolveRuntime` read `authorize` only
from the options, and only the provider passed it — so `collaborationRoutes(router)` called from
`start/routes.ts` had none, and the absent variable failed in opposite directions in the same file:
`guard()` fell to its deny literal (`403` for everyone on `/comments`, `/versions`, `/state`) while
`issueToken` skipped the check entirely (`if (authorize) {…}`), handing any authenticated caller a
token for any document. Now there is one resolution order — the explicit option, else the manager's
rule (declared document → global `authorize` → deny), else the app config, else deny — and
`issueToken` **throws `CollabForbiddenError` when it has no rule** instead of minting. Manual
registration enforces exactly what the provider and the WebSocket handshake enforce.

**`collaborationRoutes` is synchronous (API change).** It was `async` only to `await import()` the
app config, and a `RouteGroup` closes as soon as its callback returns — so it could not be wrapped in
`router.group(() => …)` and every consuming app wrote a global middleware matched against a
hardcoded `/collaboration` prefix, which silently stopped protecting anything when `routes.prefix`
changed. Config is now resolved lazily at request time and the function returns `void`; an existing
`await collaborationRoutes(...)` still works. `defaultResolveUser` also calls `ctx.auth.check()`
(or `authenticate()`) before reading `ctx.auth.user`, so a lazily-resolving auth stack produces a
caller instead of a blanket `401`.

**Comment mutations are author-or-elevated (behaviour change, security).** `PATCH`/`DELETE
/comments/:id` checked only the document-level `canComment` and then called
`comments.resolve/remove`, which never look at `userId` — anyone who could comment could resolve or
delete anyone else's thread. The rule is now explicit and exported as `canMutateComment`: the author
may always mutate their own comment, anyone else needs `canWrite` on the document. An unknown
comment id answers `404`.

**`restoreVersion` honours its contract (behaviour change).** Both drivers did `void restoredBy` and
overwrote the document without recording what they replaced, in the one operation of a version
history that most needs to be undoable. A restore now writes the pre-restore state to the history
first, as a version labelled `restored from #<seq>` attributed to `restoredBy`, and a bad
`versionId` still fails before anything is written.

**Presence is actually wired.** The provider built a `RedisPresenceStore` from `redisUrl` and the
manager wrapped it in a `PresenceService`, but `#buildDriver` never passed `presence` into the driver
options — the drivers' join/leave were dead code and `listPresence()` returned `[]` forever. It is
forwarded now, and the driver's bookkeeping is keyed by **socket** instead of by document: the old
`Map<docName, userId>` held one slot per document, so a second editor overwrote the first and either
disconnect evicted both. A user with two tabs leaves the roster only when the last one closes. The
Automerge driver feeds presence too.

**Storage and authorize failures are visible, and denial is distinct from error.** The library took no
logger and emitted no events; `onStoreDocument`/`beforeUnloadDocument` called `saveDocument` bare
inside hooks that swallow throws, and a throw from `authorize` escaped `onAuthenticate` as a generic
handshake failure — so an outage and a denial looked identical to the client, and an app-side
database error inside the rule became an unbounded reconnect storm. New: `onCollaborationError`,
`collaborationEvents`, `setCollaborationLogger` (the provider installs the Adonis logger when it can
resolve one), and `CollabAuthorizationError`, thrown when the rule could not be evaluated, alongside
`CollabForbiddenError` for an actual denial.

**Document names are type-checkable.** `defineConfig` is generic, so the literal keys of `documents`
survive instead of being widened to `string`, and the new `InferCollabDocumentNames<typeof config>`
derives the union of declared patterns (`CollabDocumentNameFor` resolves one into a concrete name
shape). The Assembler codegen hook only ever indexed `app/collaboration/documents`, which apps that
declare documents inline in `config/collaboration.ts` never create; that limitation is now stated in
the hook and the docs point at the config route.

**Also:** `AutomergeDriver.close()` no longer hangs forever on a driver that was never attached
(`this.wss?.close(cb)` never runs `cb` when there is no server). Docs corrected where they asserted
the broken behaviour: `authorize` is evaluated **once per connection**, not "on every relevant
permission change" — revoking access does not drop an open socket; the versions `POST` body has no
`userId`; and the routes, presence and manual-mode pages describe what the code does.
