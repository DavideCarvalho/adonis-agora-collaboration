# PLAN — Client-side hooks (`@adonis-agora/collaboration-client`)

## Objetivo

Criar um pacote client-side com hooks React para consumir a camada de colaboração (documento CRDT, presença/awareness, comentários, versões) de forma ergonômica e framework-idiomática. O pacote abstrai o transporte (Hocuspocus self-hosted vs PartyKit edge vs Automerge) atrás de uma interface mínima, para que apps não conheçam o driver.

## Decisões-chave (com justificativa)

1. **Pacote separado** (`packages/client` → npm `@adonis-agora/collaboration-client`), não subpath do pacote server:
   - peerDep `react` não deve poluir quem só usa o server;
   - bundling/target diferente (ESM browser, sem node deps);
   - versionamento independente.
2. **React primeiro**, via `useSyncExternalStore` — zero dependências além de react peer; padrão moderno React 18+. Vue/Solid/Qwik ficam como follow-up (a camada core é agnóstica: store + subscribe).
3. **Abstração de transporte**: interface `CollabTransport { doc, awareness?, status }` com três implementações:
   - `engine: 'yjs'` → `HocuspocusProvider` (WebSocketServer no Adonis, path `/collaboration`)
   - `engine: 'partykit'` → `YPartyKitProvider` (origin remoto; wire compatível y-protocols mas provider próprio — confirmado na pesquisa que y-websocket client **não** conecta unmodified)
   - `engine: 'automerge'` → cliente Automerge Repo network (follow-up; v1 lança erro claro)
4. **Auth flow**: browsers não mandam header em WS handshake. Fluxo:
   - hook chama `GET {baseUrl}/collaboration/token?doc=<name>` → Adonis responde JWT efêmero (mesma autorização `authorize(ctx, docName)` do server);
   - WS abre com `?token=JWT`.
   - No engine yjs self-hosted mantém-se compatibilidade com o token base64 atual durante transição (server aceita ambos; JWT recomendado).
5. **Comentários/versões via REST**: são dados relacionais (Lucid), não CRDT state — hooks fazem fetch pra rotas REST do Adonis (`/collaboration/:doc/comments`, `/versions`). **Essas rotas são geradas pelo PLAN-codegen**; este plano define o contrato.

## Contrato REST consumido pelos hooks

**docName sempre por query/body, nunca path param** — nomes de documento contêm barras (`researches/42/writing`). *(Atualizado pós-implementação: a versão original usava path params e não funcionaria.)*

| Método | Rota | Request | Response |
|---|---|---|---|
| GET | `/collaboration/token` | `?doc=` | `{ token: string, wsUrl: string, engine: string }` |
| GET | `/collaboration/comments` | `?doc=&space=` | `CollabComment[]` |
| POST | `/collaboration/comments` | body completo | `CollabComment` |
| PATCH | `/collaboration/comments/:id` | `?doc=` + `{ resolved }` | `CollabComment \| null` |
| DELETE | `/collaboration/comments/:id` | `?doc=` | `{ deleted: boolean }` |
| GET | `/collaboration/versions` | `?doc=` | `CollabVersion[]` |
| POST | `/collaboration/versions` | `{ docName, label, userId }` | `CollabVersion` |
| POST | `/collaboration/versions/restore` | `{ docName, versionId }` | `204` |
| GET | `/collaboration/state` | `?doc=` | binary update (worker PartyKit consome) |
| POST | `/collaboration/state` | `?doc=` + binary body | `204` |

Tipos `CollabComment`/`CollabVersion` duplicados como types-only no client (sem import do server) pra manter os pacotes independentes.

## API pública v1

```ts
// Provider raiz — config vem de /collaboration/config ou props
<CollaborationProvider baseUrl="https://api.app" getToken={() => sessionCookie}>

// Documento + status de conexão
const { doc, transport, status } = useCollabDoc('researches/42/writing')

// Presença (awareness): peers locais + metadados user
const peers = useAwareness(docName) // PresenceMember-like client-side

// Comentários (REST)
const { comments, create, resolve, remove, loading } = useComments(docName, 'text')

// Versões (REST)
const { versions, createVersion, restore, diff } = useVersions(docName)
```

Regras internas:
- `useCollabDoc`: 1 Y.Doc por docName por app (cache no contexto), cleanup desconecta awareness/provider; reconnect automático com backoff (o provider Hocuspocus já tem; YPartyKitProvider também).
- Hooks REST usam `useSyncExternalStore` sobre um mini-store por rota (sem dep de TanStack Query — evita peer obrigatório; adapter opcional depois).

## Escopo

**In:** pacote novo, provider, 5 hooks, tipos, testes jsdom, README.
**Out:** Vue/Solid adapters, editor bindings (Tiptap/ProseMirror glue fica pro README/exemplo), offline-first queue.

## Arquivos

| Ação | Caminho |
|---|---|
| criar | `packages/client/package.json` (peerDeps: react ^18\|\|^19; deps: yjs, y-protocols, @hocuspocus/provider, y-partykit) |
| criar | `packages/client/src/index.ts`, `types.ts`, `context.tsx` |
| criar | `packages/client/src/transports/{hocuspocus,partykit,index}.ts` |
| criar | `packages/client/src/hooks/{use_collab_doc,use_awareness,use_comments,use_versions}.ts` |
| criar | `packages/client/src/rest_client.ts` |
| criar | `packages/client/vitest.config.ts`, `tsconfig.json` (herda base) |
| criar | `packages/client/test/*.spec.tsx` |
| editar | `pnpm-workspace.yaml` (já cobre `packages/*` — verificar), turbo.json se preciso |

## Critérios de verificação

1. `pnpm --filter @adonis-agora/collaboration-client test` passa:
   - useCollabDoc monta/desmonta provider sem leak (fake transport)
   - troca de status reflete no render (useSyncExternalStore)
   - useComments CRUD contra fetch mockado
   - token flow injeta `?token=` no transport correto por engine
2. `typecheck && build` passam; bundle ESM puro (sem imports node:*).
3. Exemplo mínimo no README conectando num editor Tiptap (snippet documentável).

## Dependências entre planos

- **Contrato REST definido aqui é input do PLAN-codegen** (que gera controller/routes). Ordem sugerida de execução: este plano primeiro (contrato + mocks), codegen depois (gera o real), partykit-driver é independente mas o hook `useCollabDoc` depende da flag `engine: 'partykit'` existir no config (PLAN-partykit-driver adiciona).
