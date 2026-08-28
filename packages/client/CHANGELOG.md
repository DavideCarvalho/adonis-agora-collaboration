# @adonis-agora/collaboration-client

## 0.6.0

### Minor Changes

- 2b52ea9: **feat: `useExcalidrawSync` hook + `ExcalidrawBoard` component**

  Nova integração oficial entre o collaboration-client e o Excalidraw, sem depender
  de pacotes de terceiros (`y-excalidraw`).

  - `useExcalidrawSync({ doc, excalidrawAPI })` — liga a API imperativa do
    Excalidraw a um `CollabDoc` (Yjs). Desenho local → Y.Map.set; mudança remota
    → updateScene; montagem → restaura estado salvo.
  - `ExcalidrawBoard({ docName, baseUrl, getHeaders })` — componente pronto, já
    com `CollaborationProvider`, lazy load, CSS, pt-BR.

  Uso:

  ```tsx
  import { ExcalidrawBoard } from "@adonis-agora/collaboration-client";

  <ExcalidrawBoard
    docName="whiteboards/meu-id/canvas"
    baseUrl="https://api.app"
    getHeaders={() => ({ cookie: document.cookie })}
  />;
  ```

  Ou com hook separado:

  ```tsx
  const [api, setApi] = useState(null)
  const { doc } = useCollabDoc({ docName })
  useExcalidrawSync({ doc, excalidrawAPI: api })
  <Excalidraw excalidrawAPI={setApi} />
  ```

## 0.5.3

### Patch Changes

- Fixes three bugs that broke the WebSocket collaboration path:

  **`@adonis-agora/collaboration`**

  - `yjs_driver.ts`: hook `beforeUnloadDocument` persists the Y.Doc to storage before `unloadDocument` destroys it. Without this, F5 on a doc without a pending debounce save loses all edits — Hocuspocus only fires `onStoreDocument` if a debounce was queued, otherwise it calls `unloadDocument` and silently destroys the in-memory Y.Doc.

  **`@adonis-agora/collaboration-client`**

  - `session.ts`: circuit breaker after 5 reconnect attempts. Without this, a failed `/collaboration/token` (e.g. missing DB table, broken auth) sends the client into an infinite retry loop, and each attempt fires Y.Doc updates that the Tiptap `Collaboration` extension listens to — React error #185 (`Maximum update depth exceeded`).
  - `use_collab_doc.ts`: `session.destroy()` in the `useEffect` cleanup. Without this, the Hocuspocus Provider queues callbacks (requestIdleCallback, setTimeout) that access the Y.Doc/Awareness after the component remounts (React 18 StrictMode, navigation) — `Cannot read properties of undefined (reading 'startTime')`, which also leads to React error #185.

## 0.5.0

### Minor Changes

- 4f4a622: Enforce the document permissions, fix the wiring that made declared documents a no-op, and rewrite the docs.

  **Permissions are now enforced, not just reported.** `canWrite: false` makes the sync connection
  read-only (Hocuspocus connection config on Yjs, dropped inbound messages on Automerge) — the client
  still receives every edit, its own are ignored. The built-in REST routes resolve the caller and
  check the matching permission before touching anything: `canRead` to read comments, versions and
  state; `canWrite` to create or restore a version; `canComment` to write a comment. A comment is
  attributed to the authenticated user, and a `userId` in the request body is ignored.

  Apps mounting these routes without auth middleware will now get `401` instead of unauthenticated
  access — set `routes.middleware`.

  **Fixes:**

  - `config.documents` was never forwarded from the provider to the manager, so every `defineDocument`
    declaration was silently ignored — per-document `engine` and `authorize` never applied. The REST
    token endpoint also used only the global `authorize`, which bypassed per-document rules entirely
    on the edge engines.
  - The published migrations created a different schema from the one `LucidStorage` queries
    (`document_name` vs `doc_name`, no `state` column), so running them broke every read.
  - `LucidStorage` discarded version snapshots and `loadVersionSnapshot` returned the current
    document, making `restoreVersion` and `diffVersions` silent no-ops.
  - `lucidStorage()` defaulted to a hard-coded connection name; it now falls back to the app's default
    connection.

  **Client:** `useAwareness` also returns the `awareness` channel, which is what Tiptap's
  `CollaborationCursor` needs to publish the local caret.

## 0.2.0

### Minor Changes

- badb9f7: First release. React hooks for the Adonis collaboration package: `useCollabDoc` (Y.Doc + connection status with per-doc session caching), `useAwareness` (presence peers), `useComments` and `useVersions` (REST-backed anchored comments and version control). Transports are auto-selected from the server engine (Hocuspocus self-hosted or PartyKit edge) and can be overridden via a custom `createTransport` factory.
