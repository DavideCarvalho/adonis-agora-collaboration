---
"@adonis-agora/collaboration": patch
---

`config/collaboration.ts` describes what it runs on under `Symbol.for('@adonis-agora/stack')`: the Lucid or file-system storage (`documents`), `redisUrl` (`presence`, linked to the matching `config/redis.ts` connection when there is one) and the PartyKit host (`sync`). The provider resolves the default Lucid connection and its client, so telescope's Architecture page shows them with no extra code.
