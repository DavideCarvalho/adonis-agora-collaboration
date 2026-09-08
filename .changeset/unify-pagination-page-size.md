---
'@adonis-agora/collaboration': minor
---

**Breaking:** the list pagination shape is now `{ page, size }` instead of `{ limit, offset }`.

Every `@adonis-agora/*` package now pages the same way — the shape `@adonis-agora/filter` already
used (`FilterInput.page`/`.size`, wire format `?page=1&size=25`). This package matched it
structurally; it does **not** take a dependency on `@adonis-agora/filter`.

What changed:

- `ListPageOptions` is now `{ page?: number; size?: number }`. `page` is **1-based** (default `1`);
  `size` is the page size (default `50`, capped at `200` — unchanged values). The 0-based SQL offset
  is derived inside each storage as `(page - 1) * size` and no longer appears anywhere on the public
  interface.
- `COLLAB_LIST_DEFAULT_LIMIT` → `COLLAB_LIST_DEFAULT_SIZE`, `COLLAB_LIST_MAX_LIMIT` →
  `COLLAB_LIST_MAX_SIZE`; `clampLimit`/`clampOffset` → `clampSize`/`clampPage` plus a new
  `resolvePage` that turns a `{ page, size }` request into the `{ size, offset }` a store needs.
- `CollaborationManager.listVersions({ docName, limit, offset })` → `({ docName, page, size })`.
- `GET /collaboration/versions` and `GET /collaboration/comments` read `?page=&size=` instead of
  `?limit=&offset=`.
- `ListPageOptions` is now exported from the package root, as the custom-storage docs already
  assumed.

Unchanged: `page` stays **optional**, and omitting it still returns every row — internal callers
(the next-`seq` computation, the restore-target lookup) depend on that; only the HTTP routes always
supply a page.

Migration:

```ts
// before — 0-based offset
await storage.listVersions('docs/1', { limit: 25, offset: 50 })
await manager.listVersions({ docName: 'docs/1', limit: 25, offset: 50 })
// GET /collaboration/versions?doc=docs/1&limit=25&offset=50

// after — 1-based page
await storage.listVersions('docs/1', { page: 3, size: 25 })
await manager.listVersions({ docName: 'docs/1', page: 3, size: 25 })
// GET /collaboration/versions?doc=docs/1&page=3&size=25
```

The conversion is `page = offset / size + 1` (and `size = limit`). A custom `CollaborationStorage`
implementation must be updated: `page.limit`/`page.offset` are gone, and it now computes its own
offset from the 1-based `page.page`.
