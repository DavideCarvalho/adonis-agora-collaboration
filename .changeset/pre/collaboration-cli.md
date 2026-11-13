---
"@adonis-agora/collaboration": minor
---

`node ace` commands for documents, versions and comments: `collaboration:documents:list|show`, `collaboration:versions:list|create|restore` and `collaboration:comments:list|resolve|delete`. They call the same manager methods as the REST routes, print a table or `--json` (`{ data, meta }` for lists), ask before restore/delete unless `--force`, and record `cli:<os user>` as the version author. A restore refuses while anyone is in presence. New `CollaborationManager.listDocumentDeclarations()` and `describeDocument({ docName })`.
