---
"@adonis-agora/collaboration-client": patch
---

perf: `useAwareness` (and `useCollabEditor`, which uses it) keeps the same `peers` array when an awareness change does not alter any peer's `clientId`, `userId`, `name` or `avatarUrl`. Remote cursor and selection moves fire awareness `change` on every keystroke; they no longer re-render the component that renders the peer list.
