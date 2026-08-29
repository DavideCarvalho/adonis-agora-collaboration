---
'@adonis-agora/collaboration-client': patch
---

A permanent failure is no longer retried, and no longer loses its reason

An engine this package has no client for, a document the server refuses, a config that
cannot build a transport — none of those can succeed on a retry. The session scheduled one
anyway, and after the fifth attempt `#scheduleReconnect` REPLACED `error` with
"reconnect: exceeded 5 attempts". So the reader was left holding the one fact they can do
nothing about, while the one that named the actual problem had been discarded.

Permanent failures now stop at the first attempt, and when a retryable one does exhaust its
budget the message carries the last real failure and sets it as `cause`.
