---
"@adonis-agora/collaboration": major
---

Security: on the `partykit` engine, read-only users could edit documents. **Regenerate and redeploy the PartyKit worker** (`node ace collaboration:init --engine=partykit --force`, then `npx partykit deploy`).

- Edge tokens now carry a `canWrite` claim taken from `authorize`. The worker opens the socket read-only unless it is `true`, so a reader's Yjs updates are no longer applied, stored or persisted.
- The worker's HTTP API (`onRequest`, used for state reads and version restore) only accepts tokens signed with a server key derived from `jwtSecret`. No browser token is signed with that key. Before, any user token could POST an update into the room.
- The worker → Adonis secret (`x-collab-worker-secret`) is now derived from `jwtSecret` (HKDF), so the JWT signing key no longer travels as a request header. No new env var: remove `COLLAB_WORKER_SECRET` from the worker (`npx partykit secret delete COLLAB_WORKER_SECRET`). The optional `partykit.workerSecret` overrides the derived value.
- An outdated worker fails loudly. `POST /collaboration/state` answers `403` and driver calls fail with a `401` `PartyKitRoomError`; both messages name the upgrade steps. The provider warns at boot while `partykit-worker/party.ts` predates the current template.
- The worker's initial load now works. It used to call `GET /collaboration/state` without a user session, get refused, and start every room empty, which Durable Object storage hid. It now authenticates with a one-minute token signed with the worker secret and bound to that document, and gets the stored state (`404` when nothing is stored).
- `collaboration:init` gains `--force`, which overwrites the generated worker files.
