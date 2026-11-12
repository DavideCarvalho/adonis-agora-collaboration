---
'@adonis-agora/collaboration': minor
---

`lucidStorage({ connection, schema })`: the `collab_documents`, `collab_versions` and `collab_comments` tables live in their own Postgres schema (MySQL: database). Every query names it, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode; the first use creates the schema when missing and explains the grant when the role cannot. `collaboration:init --schema` (defaulting to the configured one) publishes migrations that create the schema and the tables in it. A `schema` on a SQLite connection fails the boot. Two processes creating the tables at the same moment no longer fail, and a failed table creation is retried on the next call.
