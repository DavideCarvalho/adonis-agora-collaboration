---
"@adonis-agora/collaboration": major
"@adonis-agora/collaboration-client": major
---

`GET /comments` and `GET /versions` use the `@adonis-agora/filter` list format: `filter[space]`, `sort` (`createdAt`/`-createdAt` for comments, `seq`/`-seq` for versions), 1-based `page` + `size`, answered as `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`. An unknown filter field or sort answers `400`. `order` and the flat `space` param are gone. Storages may implement the optional `countVersions` / `countComments`; the manager gains `countVersions({ docName })` and `comments.count(docName, space?)`.

The client's `listComments(config, docName, { space?, sort?, page?, size? })` and `listVersions(config, docName, { sort?, page?, size? })` return `OffsetPage<T>`; `useComments` / `useVersions` take `sort` instead of `order` and return `meta`.
