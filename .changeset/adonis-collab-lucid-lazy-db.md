---
'@adonis-agora/collaboration': patch
---

**fix(lucid): lazy resolve db facade to avoid boot-time race**

The static `import dbFacade from '@adonisjs/lucid/services/db'` evaluated the
module before the Lucid provider had registered the facade, so `dbFacade` was
`undefined` and every `LucidStorage` operation crashed with
`Cannot read properties of undefined (reading 'connection')`.

Replaced the static import with a dynamic `import()` inside `knex()`, cached
in a static field. The first call to any storage method (e.g. `saveDocument`,
`loadDocument`) resolves the facade lazily — by then the app is fully booted
and the facade is available.

The constructor still accepts an optional `db` argument for tests that provide
a mocked or real connection directly.