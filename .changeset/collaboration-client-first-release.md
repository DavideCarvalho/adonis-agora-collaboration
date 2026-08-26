---
'@adonis-agora/collaboration-client': minor
---

First release. React hooks for the Adonis collaboration package: `useCollabDoc` (Y.Doc + connection status with per-doc session caching), `useAwareness` (presence peers), `useComments` and `useVersions` (REST-backed anchored comments and version control). Transports are auto-selected from the server engine (Hocuspocus self-hosted or PartyKit edge) and can be overridden via a custom `createTransport` factory.
