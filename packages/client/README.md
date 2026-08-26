# @adonis-agora/collaboration-client

React client hooks for [`@adonis-agora/collaboration`](https://github.com/DavideCarvalho/adonis-agora-collaboration) — collaborative documents, presence, anchored comments and version control with automatic transport selection (Hocuspocus self-hosted or PartyKit edge).

React 18/19 · zero dependencies beyond `yjs` stack · ESM.

## Install

```sh
pnpm add @adonis-agora/collaboration-client
```

Server side: install `@adonis-agora/collaboration` and run `node ace collaboration:init` to publish the REST routes these hooks consume.

## Usage

Wrap your app once:

```tsx
import { CollaborationProvider } from '@adonis-agora/collaboration-client'

<CollaborationProvider
  baseUrl="https://api.app"
  getHeaders={() => ({ cookie: sessionCookie })}
>
  <App />
</CollaborationProvider>
```

Then per collaborative view:

```tsx
import {
  useCollabDoc,
  useAwareness,
  useComments,
  useVersions,
} from '@adonis-agora/collaboration-client'

function Writing({ docName }: { docName: string }) {
  // Y.Doc shared per docName (cached across mounts), + connection status
  const { doc, status, error } = useCollabDoc(docName)
  const { peers } = useAwareness(docName)          // who's online
  const { comments, create, resolve, remove } = useComments(docName, 'text')
  const { versions, create: createVersion, restore } = useVersions(docName)

  if (status === 'error') return <p>{error?.message}</p>

  return (
    <>
      {/* feed `doc` into Tiptap / ProseMirror / Monaco… */}
      {peers.map((peer) => <Avatar key={peer.clientId} name={peer.name} />)}
    </>
  )
}
```

## How it works

1. `useCollabDoc` fetches an ephemeral token from `GET {baseUrl}/collaboration/token?doc=<name>` (your auth middleware protects this route).
2. The response's `engine` field picks the transport:
   - `yjs` → `HocuspocusProvider` against the Adonis server (`wsUrl` path)
   - `partykit` → `YPartyKitProvider` straight to the Cloudflare room
3. Comments and versions are **REST**, not CRDT state — they live in your database via the server package's storage.
4. Sessions survive component unmounts; one `Y.Doc` per document name per provider.

## Custom transport

Bring your own sync engine by injecting a factory:

```tsx
<CollaborationProvider baseUrl="…" createTransport={(info, doc, docName) => new MyTransport(info, doc)}>
```

## API

| Hook | Returns |
|---|---|
| `useCollabDoc(docName)` | `{ doc: Y.Doc, status: 'connecting'\|'connected'\|'disconnected'\|'error', error }` |
| `useAwareness(docName)` | `{ peers: CollabPeer[], status }` |
| `useComments(docName, space?)` | `{ comments, loading, error, refresh, create, resolve, remove }` |
| `useVersions(docName)` | `{ versions, loading, error, refresh, create, restore }` |

## License

MIT
