---
'@adonis-agora/collaboration': minor
---

A `load` hook per document, and a public API for the live document.

`documents` entries take a `load({ docName, params })` — the document's **first** content, asked
for only when the storage has never stored that name, and persisted before the document is served.
Return the engine's binary state (`Y.encodeStateAsUpdate`, `A.save`), a `Y.Doc` on the Yjs engine,
or `null` for "nothing to seed"; `params` is typed from the pattern key exactly like `authorize`'s.
It runs once per document rather than once per connection, a throw is reported and opens the
document empty instead of failing the handshake, and two connections racing on a new document seed
it once. Both self-hosted engines have it.

It exists because the alternative is not "the app seeds it": it is "the app seeds it from a request
it believes precedes the WebSocket". Losing that race is destructive rather than merely wrong — the
editor mounts against an empty CRDT document, that is what it shows, and the first autosave writes
the emptiness over the text in the database.

`CollaborationManager` gains `withLiveDocument({ docName, run })`, `hasLiveDocument({ docName })`
and `getVersionState({ docName, versionId })`. `withLiveDocument` lends the real in-process
document to a callback — an external change (a Drive webhook, a cron) has to merge into the
instance people are typing into, and `getDocumentState` only ever hands out a copy — and answers
`{ live: true, value }` or `{ live: false, reason }`, so a document nobody has open, or one on an
engine that syncs elsewhere, is an answer instead of an invalid cast. The app that needed this was
reaching `manager.drivers.get('yjs').liveDoc(name)` through a cast onto two private fields.

Fixes a silent bug in the Yjs driver on the way: `onLoadDocument` returned `{ document }`, the
Hocuspocus v1 shape, and Hocuspocus 4 applies the hook's result only when it is a `Y.Doc` or a
`Uint8Array` — so the persisted state was read, handed to a branch that ignored it, and every
socket got an empty document. Only a test calling the hook directly could still see it "work".

`YjsDriver.liveDoc` and `YjsDriver.versionState` were private; they are now `liveDocument` and
`getVersionState`, the latter on the `CollaborationDriver` contract (implemented by all three
drivers). Nothing on `CollaborationManager` changed shape — `getDocumentState`, `getDocumentText`,
`listVersions` and the rest keep working exactly as before.
