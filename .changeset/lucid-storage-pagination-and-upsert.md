---
'@adonis-agora/collaboration': minor
---

`GET /collaboration/versions` and `GET /collaboration/comments` no longer return every row.

`LucidStorage.listVersions`/`listComments` had no `LIMIT`, so a long-lived, frequently-versioned
or frequently-commented document came back as one ever-growing JSON array. Both routes now accept
`limit`/`offset` query params, clamped server-side to `1..200` (default `50`) the same way
`@adonis-agora/payments` already clamps its billing lists — an unbounded or negative value from the
query string can no longer select the whole table.

The bound is a new, optional third argument on `CollaborationStorage.listVersions`/`listComments`
(`{ limit?, offset? }`). It is opt-in on purpose: omitting it still returns every row, which is what
the drivers need internally to compute the next version's `seq` and to resolve a restore's target —
only the HTTP route always supplies one. `InMemoryCollaborationStorage` and `FileSystemStorage` (the
library's other two storages) implement the same optional bound, so a custom `CollaborationStorage`
has one contract to satisfy across all three.

Also: `LucidStorage.saveDocument`/`saveComment` ran a `SELECT ... first()` to decide insert-vs-update
before writing — two round-trips per save, on every debounce flush of every actively-edited document
(the Yjs driver debounces every 2s). Both now emit a single `insert(...).onConflict(...).merge(...)`,
the same upsert idiom `saveVersion` already used for its own conflict handling. Behaviour is
unchanged (a save on an existing row still updates, `created_at` is still preserved); this is a
round-trip reduction, not a semver-relevant API change on its own.
