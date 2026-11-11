---
"@adonis-agora/collaboration": minor
"@adonis-agora/collaboration-client": minor
---

Comment and version lists can be paged and sorted from the client, and the client follows a custom route prefix.

- `GET /comments` and `GET /versions` accept `order=desc` (newest first; default `asc`). `ListPageOptions` gains `order`, and `manager.listVersions` / `manager.comments.list` pass it to the storage. A custom `CollaborationStorage` should honour `page.order` in `listVersions` and `listComments`.
- `useVersions` and `useComments` take `page`, `size` and `order`, and refetch when they change. `listVersions(config, docName, options?)` and `listComments(config, docName, space?, options?)` send them. New `CollabListOptions`, `UseVersionsOptions` and `UseCommentsOptions` types.
- `CollaborationProvider` takes `prefix` (default `/collaboration`), so a server with `routes.prefix: '/api/collab'` is reachable without a custom `fetchImpl`.
