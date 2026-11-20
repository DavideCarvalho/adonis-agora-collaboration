---
"@adonis-agora/collaboration": minor
---

createdAt / updatedAt on documents and comments. `CollaborationStorage.loadDocument` may return `createdAt` / `updatedAt` (`Date`, optional, new `StoredCollabDocument` type): Lucid reads the existing `collab_documents.created_at` / `updated_at` columns, the memory storage tracks them and the file storage reports the file times. `describeDocument()` and `collaboration:documents:show` show them (ISO, `null` when unknown). A new comment now starts with `updatedAt` equal to `createdAt` instead of `null` (Lucid already stored it that way), and Lucid stores the comment's own `updatedAt`. No schema change.
