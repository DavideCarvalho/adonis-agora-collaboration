---
"@adonis-agora/collaboration": patch
---

Yjs: saving a live document no longer drops changes another process wrote to storage. Every save (the debounced autosave, the save when the last client leaves, `restoreVersion`) first merges the stored state into the live document, then writes the union. Connected clients receive the merged changes. If the stored state can't be read, the save fails and nothing is overwritten. New `getStoredDocumentState({ docName })` reads storage even when this process has the document open.
