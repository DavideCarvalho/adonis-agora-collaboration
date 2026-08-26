# PLAN — PartyKitDriver (edge sync engine)

## Objetivo

Adicionar um terceiro driver CRDT ao `@adonis-agora/collaboration`: `PartyKitDriver`, que usa o PartyKit (Cloudflare Workers + Durable Objects) como motor de sync WebSocket em edge, mantendo version control e comentários no lado Adonis (Lucid storage).

## Contexto da pesquisa (fatos que condicionam o design)

- **Origin separado**: PartyKit roda como Worker standalone (`npx partykit deploy` → `*.partykit.dev`). O padrão atual `attach(nodeServer)` **não se aplica** — clientes conectam direto ao room URL, sem passar pelo Adonis.
- **Pacotes**: `y-partykit` v0.0.33 (server `onConnect` + client `/provider`) sobre `partykit/server`. Peer deps: `yjs ^13.6.16`, `y-protocols ^1.0.6` — compatível com nossa stack.
- **Wire protocol**: mesmo formato y-protocols sync/awareness, mas endpoint é `/parties/{party}/{room}` — client precisa trocar `HocuspocusProvider` por `YPartyKitProvider` (ver PLAN-client-hooks para a abstração).
- **Auth**: static `onBeforeConnect(request, lobby)` valida token via query param e retorna `Response` pra rejeitar.
- **Persistência**: DO storage nativo (`persist: { mode: "snapshot" }`, limite 128 KiB/value) OU external via `load()` + `callback.handler(yDoc)` com debounce — este último aponta de volta pro Adonis por HTTP autenticado.
- **Estado do projeto**: adquirido pela Cloudflare (abr/2024), pacotes efetivamente congelados desde mid-2025. Sucessores ativos: `partyserver` / `y-partyserver`. **Escopo inicial continua y-partykit** (docs estáveis, amplamente usado); adapter `y-partyserver` fica como follow-up explícito.
- **Gotcha conhecido**: issue #445 — "Yjs was already imported" ao bundlar TipTap + y-partykit. Mitigar documentando resolução única de `yjs >=13.6.16`.

## Decisão arquitetural

O driver é um **cliente HTTP do worker**, não um host de WebSocket:

```
Browser ──WS──▶ PartyKit room (DO) ──callback.handler──HTTP──▶ Adonis (save snapshot)
Browser ──WS──▶ PartyKit room (DO)
Adonis  ──HTTP─▶ PartyKit room onRequest (/state, /text)  ← PartyKitDriver vive aqui
```

1. **`attach(server)`**: no-op intencional (log informativo). Nenhum upgrade WS no Node — o tráfego vai direto browser→edge.
2. **Server-side ops** (`getDocumentState`, `getDocumentText`): HTTP GET pro `onRequest` do worker, que responde `Y.encodeStateAsUpdate(doc)` ou texto plano.
3. **Version control + comments**: permanecem 100% no lado Adonis usando a `CollaborationStorage` existente. `createVersion` busca o estado atual por HTTP antes de salvar o snapshot — mesma semântica dos drivers Yjs/Automerge.
4. **Worker template shippado como stub**: o usuário copia/deploya o worker do seu projeto (via `collaboration:init` do PLAN-codegen). O template contém: `onBeforeConnect` (JWT/token), delegação `onConnect → onConnect(conn, party, { persist })`, `onRequest` handlers, e callback de persistência apontando pra rota Adonis.
5. **Auth flow**: o client pede token efêmero pro Adonis (`GET /collaboration/token?doc=...`, rota do codegen) e abre o WS com `?token=...`. O worker valida com o mesmo segredo (JWT HS256 recomendado — substitui o base64 JSON atual, que é inseguro cross-origin).

## Escopo

**In:**
- `src/drivers/partykit/partykit_driver.ts` implementando `CollaborationDriver`
- Template de worker em `stubs/partykit/worker/` (party.ts, partykit.toml.stub, package.json.stub)
- Novo engine type `'partykit'` em `CollaborationEngine` (types.ts:11)
- Config: `CollaborationConfig.partykit?: { roomHost: string; party?: string; jwtSecret?: string }`
- Testes vitest com fetch mockado

**Out (follow-ups):**
- Adapter `y-partyserver`/`partyserver` (sucessor ativo)
- Spawn local de `partykit dev` durante desenvolvimento
- Persistência R2

## Arquivos

| Ação | Caminho |
|---|---|
| criar | `packages/adonis/src/drivers/partykit/partykit_driver.ts` |
| criar | `packages/adonis/stubs/partykit/worker/party.ts` |
| criar | `packages/adonis/stubs/partykit/worker/package.json.stub` |
| criar | `packages/adonis/stubs/partykit/worker/partykit.toml.stub` |
| editar | `packages/adonis/src/types.ts` (engine union + config) |
| editar | `packages/adonis/src/collaboration_manager.ts` (factory do driver) |
| editar | `packages/adonis/src/index.ts` + `package.json` exports (`./drivers/partykit`) |
| editar | `packages/adonis/scripts/copy:stubs` (incluir novos stubs) |
| criar | `packages/adonis/test/partykit_driver.spec.ts` |

## Interface interna (contrato do driver com o worker)

- `GET  {roomHost}/parties/main/{docName}?token=JWT` → headers `x-return: update|text` no onRequest do worker (o worker decide o formato; header evita path routing custom).
- Erros HTTP ≥400 → exceção tipada `PartyKitRoomError` (inclui status + body).
- Timeout de fetch: 10s default, configurável.

## Critérios de verificação

1. `pnpm --filter @adonis-agora/collaboration test` passa com os novos specs:
   - `getDocumentState` faz GET correto e retorna bytes do mock
   - `getDocumentText` idem
   - `createVersion` busca estado remoto + persiste via storage injetado
   - authorize/JWT: token gerado contém docName + exp correta
   - `attach()` é no-op sem lançar
   - `close()` limpa timers/recursos
2. `pnpm typecheck && pnpm build` passam (exports map resolve).
3. Smoke manual documentado no README: subir worker com `partykit dev` + conectar Tiptap via `YPartyKitProvider` (instrução, não CI).

## Riscos

- Projeto congelado → mitigação: interface do driver isola; follow-up y-partyserver já mapeado.
- Round-trip HTTP por operação server-side adiciona latência em createVersion/diff — aceitável (operações raras, não hot path).
- Limite 128 KiB/value no DO storage para docs grandes → usar modo `history` capped ou external persist callback (default do template).


---

## Pós-implementação
- Implementado conforme plano; worker stub corrigido depois (doc = room name, shared secret no POST /state, referência ao doc vivo capturada no callback).
- Adapter `y-partyserver` permanece follow-up (ver PLAN-codegen → Decisões finais).
