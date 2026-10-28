---
"@adonis-agora/collaboration": patch
---

perf(presence): send the 20 s presence refresh of every open document in a single Redis pipeline (one write and one round trip per tick) instead of one MULTI/EXEC per document. Each document keeps its own MULTI/EXEC with the same keys, TTLs and failure isolation.
