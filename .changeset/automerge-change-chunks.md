---
"@adonis-agora/collaboration": patch
"@adonis-agora/collaboration-client": patch
---

Automerge: clients and server exchange change chunks instead of whole documents. `useAutomergeDoc` asks for them with `?sync=changes`; the server acknowledges with a text frame and from then on both sides send only the changes the other lacks. Sockets that do not ask (older clients) keep sending and receiving whole documents, and a new client against an older server keeps sending whole documents, so mixed versions keep working in the same room. The server applies both shapes with `A.loadIncremental` and never forwards a payload that adds nothing.

Automerge rooms are now saved and dropped from memory when their last client leaves, `close()` writes pending saves instead of cancelling them (and no longer hangs while sockets are open), and a document edited without pause is saved at least every 10 seconds.

A socket whose presence join fails, or that closes while the join is in flight, is now taken out of its room (which can then be dropped) and its possibly half-written roster entry is removed, unless the user still has another tab on the document.
