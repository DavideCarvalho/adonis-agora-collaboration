---
"@adonis-agora/collaboration": minor
---

Storage codecs for encryption at rest: `lucidStorage({ codec })` and `withCodec(storage, codec)` run an async `{ encode, decode }` over document state, version snapshots, comment bodies and comment anchors, with `{ docName, kind, field, versionId?, commentId?, meta? }` to pick a key. The server still works on plaintext in memory. Existing plaintext rows keep loading and are encoded on their next save, or all at once with `node ace collaboration:reencode` (`LucidStorage.reencodeAll`). A value that fails to decode throws a `StorageCodecError`, and the storage then refuses to save that document instead of overwriting it. `CollaborationStorage.loadDocument` may now return `meta`, and `LucidStorage.loadDocument` does.
