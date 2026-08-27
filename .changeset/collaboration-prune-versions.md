---
'@adonis-agora/collaboration': minor
---

Add version retention to the library instead of the docs: `pruneVersions` on the storage SPI, `collaboration:prune` on the CLI.

**The API.** `CollaborationStorage` gains
`pruneVersions({ keep, docName?, dryRun? }): Promise<number>` — delete all but the `keep` most
recent versions and return how many went. `keep` is counted **per document**, so a document
versioned every minute never evicts the history of one versioned twice a year; `docName` narrows
the run to one document and `dryRun` counts without deleting. `keep: 0` deletes every version,
while a negative, fractional or `NaN` `keep` throws instead of silently wiping the history the
caller meant to keep. Implemented in all three built-in storages, and exposed on the manager as
`collaboration.current.pruneVersions({ keep })` for scheduling it from code.

**The command.** `node ace collaboration:prune --keep=20 [--doc=<name>] [--dry-run]` prints how
many versions it removed. The docs previously told you to run a hand-written
`DELETE FROM collab_versions` for this; they no longer do.

**Fixes found by running the Lucid storage against a real Postgres** (a new
`pnpm test:integration` suite boots a throwaway container and runs the *published* migrations):

- `LucidStorage` could not insert anything through a real Lucid connection. `db.connection().from(table)`
  returns the SELECT builder, which has no `insert()` — so saving a document, a version or a comment
  threw `insert is not a function`. The three insert paths now use `.table(...)`, which is the insert
  builder on both Lucid and knex.
- The lazy `CREATE TABLE IF NOT EXISTS` bootstrap crashed on any app that had run the published
  migrations: knex skips the table but still emits its `CREATE INDEX`, which fails with
  `relation "collab_comments_doc_name_space_index" already exists`. Existing tables are now left
  alone.

**Custom storages** must implement `pruneVersions` — the custom-storage guide documents the
per-document contract, including the worked example.
