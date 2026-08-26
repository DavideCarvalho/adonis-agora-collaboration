# @adonis-agora/collaboration

Collaborative editing (CRDT) for AdonisJS — Yjs (Hocuspocus), Automerge and PartyKit (edge) drivers, Redis-backed presence, unified version control, anchored comments, ace codegen and React client hooks. Part of the Agora ecosystem.

## Install

```sh
node ace add @adonis-agora/collaboration
```

## Quick start

```sh
node ace configure @adonis-agora/collaboration   # provider + config/collaboration.ts
node ace collaboration:init                       # REST routes, controller, migrations
node ace make:collab-document researches/writing  # shared types per document
```

Wire `config/collaboration.ts` with your `authorize()` (the lib never authorizes by default) and a storage backend (`LucidStorage`, `FileSystemStorage` or your own).

### Engines

| Engine | Sync runs on | Best for |
|---|---|---|
| `yjs` (default) | Embedded Hocuspocus on the Adonis HTTP server | Self-hosted, single origin |
| `automerge` | Custom room broadcast on Adonis server | Native history |
| `partykit` | Cloudflare Workers + Durable Objects (edge) | Global latency, separate origin |

PartyKit setup:

```ts
// config/collaboration.ts
{
  engine: 'partykit',
  partykit: { roomHost: 'meu-app.partykit.dev', jwtSecret: process.env.COLLAB_JWT_SECRET },
}
```

Then run `collaboration:init --engine=partykit` to scaffold the worker into `partykit-worker/` and deploy with `npx partykit deploy`.

## Server API

```ts
import collaboration from '@adonis-agora/collaboration/services/main'

await collaboration.current.getDocumentText('researches/42/writing')
const version = await collaboration.current.createVersion('researches/42/writing', userId, 'v1')
collaboration.current.comments.list('researches/42/writing', 'text')
```

Version control works across engines: full-update snapshots (Yjs/PartyKit) or native heads (Automerge). Comments are anchored per space (`text-range`, `canvas-object`, `timestamp`) and persisted via the storage backend.

## Client hooks (React)

```sh
pnpm add @adonis-agora/collaboration-client
```

```tsx
import {
  CollaborationProvider,
  useCollabDoc,
  useAwareness,
  useComments,
  useVersions,
} from '@adonis-agora/collaboration-client'

<CollaborationProvider baseUrl="https://api.app" getHeaders={() => ({ cookie })}>
  <Editor docName="researches/42/writing" />
</CollaborationProvider>

function Editor({ docName }: { docName: string }) {
  const { doc, status } = useCollabDoc(docName)   // Y.Doc + connection status
  const { peers } = useAwareness(docName)
  const { comments, create, resolve } = useComments(docName, 'text')
  const { versions, create: createVersion } = useVersions(docName)
  // feed doc into Tiptap/y-prosemirror…
}
```

The transport is chosen automatically from the engine reported by `GET /collaboration/token` (HocuspocusProvider or YPartyKitProvider).

## Codegen

### Commands

- `collaboration:init` — scaffolds the documents directory, base migrations (when a database is configured) and the PartyKit worker (`--engine=partykit`)
- `make:collab-document <name>` — generates shared document types in `app/collaboration/documents/` (spaces + allowed anchor kinds), importable by the frontend

Commands are registered automatically by `configure`; manual setups need `commands: ['@adonis-agora/collaboration/commands']` in `adonisrc.ts`.

### Typed document registry

The package ships an Assembler `init` hook (registered by `configure`) that scans `app/collaboration/documents/` and generates `.adonisjs/collaboration/documents.ts`:

```ts
import type { CollabDocumentName, CollabDocumentDefinition } from '.adonisjs/collaboration/documents.js'

function open(name: CollabDocumentName) { … }   // autocomplete + exhaustiveness
```

Refresh it with `node ace codegen`, the dev server, tests or build — same lifecycle as controllers/routes barrels.

## REST endpoints

Ten endpoints ship built-in (token, comments CRUD, versions, binary state) and are **registered automatically** on boot under `/collaboration`.

Protect them via config — any Adonis middleware or auth guard works:

```ts
// config/collaboration.ts
routes: {
  enabled: true,
  prefix: '/collaboration',
  middleware: [() => import('#middleware/auth_middleware')], // guards apply here
}
```

Prefer full control? Disable and register manually where you want:

```ts
// routes.enabled = false
import { collaborationRoutes } from '@adonis-agora/collaboration'

collaborationRoutes(router, {
  prefix: '/api/collab',
  middleware: [authMiddleware],
})
```

Without a resolver the token endpoint fails closed (401): pass `routes.resolveUser` or run your auth middleware first. The binary `state` POST is machine-to-machine (PartyKit worker → Adonis) and requires the shared worker secret instead of a user.

> **Route type-safety caveat**: auto-registered routes live in the provider's `ready()` phase, which runs after the codegen warmup — so they may not appear in `.adonisjs/server/routes.d.ts`. If your app relies on generated route types (e.g. Tuyau), use manual mode: set `routes.enabled = false` and call `collaborationRoutes(router)` in `start/routes.ts`, where routes are always picked up.

## Editor binding (Tiptap)

The client hooks hand you a plain `Y.Doc` — feed it straight into Tiptap:

```tsx
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCollabDoc, useAwareness } from '@adonis-agora/collaboration-client'

function Editor({ docName, user }: { docName: string; user: { name: string; color: string } }) {
  const { doc, status } = useCollabDoc(docName)
  const { peers } = useAwareness(docName)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Collaboration.configure({ document: doc }),
      CollaborationCursor.configure({ user }),
    ],
    editable: status === 'connected',
  })

  return (
    <>
      <EditorContent editor={editor} />
      {peers.map((peer) => (
        <span key={peer.clientId} style={{ color: 'gray' }}>{peer.name ?? 'anon'}</span>
      ))}
    </>
  )
}
```

## License

MIT
