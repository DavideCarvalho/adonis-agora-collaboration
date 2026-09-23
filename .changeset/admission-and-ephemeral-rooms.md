---
"@adonis-agora/collaboration": minor
---

Add `beginAdmission` and `isEphemeralRoom` to the config (self-hosted Yjs engine), and forward every config key from the provider to the manager

- `beginAdmission(ctx, docName, socketId)` opens a handshake barrier before `authorize` and ends it exactly once: `connected()` when the socket finishes the handshake, `closed()` when it never does (authorize denied or threw, socket dropped mid-handshake, shutdown).
- `isEphemeralRoom(docName)` marks rooms whose durable state the app owns: they are still loaded through `storage.loadDocument`, but never seeded, stored, flushed on unload, versioned, restored or persisted through `persistDocument`. Throwing from storage for such a room used to make Hocuspocus keep it in memory forever and serve that stale copy to the next socket.
- The provider no longer builds the manager config from an allowlist, which silently dropped any key it did not list. It forwards the whole app config (minus `routes`, and `redisUrl` becomes `redis`), and the build fails if the app config gains a key the manager config does not have.
