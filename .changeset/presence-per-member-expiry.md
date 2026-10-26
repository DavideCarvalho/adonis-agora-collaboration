---
"@adonis-agora/collaboration": patch
---

Presence: each roster entry now expires on its own 60-second TTL, and every live instance re-stamps the members it holds every 20 seconds, so the users of a crashed instance drop out even on a document other instances keep busy. The stored member format is unchanged. The Yjs driver no longer scans every open socket on each disconnect.
