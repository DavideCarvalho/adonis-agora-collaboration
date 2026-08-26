# PLAN — Codegen (`collaboration:init` + `make:collab-document`)

## Objetivo

Adicionar comandos ace ao pacote que geram todo o wiring de colaboração automaticamente: rotas REST, controller, migration/model Lucid, tipos client e (opcional) worker PartyKit — seguindo exatamente as convenções dos pacotes oficiais AdonisJS.

## Convenções confirmadas pela pesquisa (fonte: `@adonisjs/lucid` build local)

1. **Descoberta de comandos**: NÃO é via provider. É via array `commands: []` no `adonisrc.ts` → kernel faz lazy import. Nosso `configure.ts` precisa chamar `rcFile.addCommand('@adonis-agora/collaboration/commands')` além do `addProvider` atual.
2. **Barrel de comandos**: export `"./commands"` aponta pra um barrel que lê um `commands.json` gerado em build time por `adonis-kit index dist/commands`. O JSON lista `{ commandName, flags, args, filePath }`.
3. **Skeleton do comando** (espelhar `make_migration.js` do lucid):
   - `import { BaseCommand, flags, args } from '@adonisjs/core/ace'`
   - `static commandName`, `static description`, `static options = { startApp }`
   - args/flags via decorators (`__decorate([...args.string(...)], ...)`) — requer `experimentalDecorators` (já padrão Adonis)
   - `run()` usa `this.createCodemods()` → `codemods.makeUsingStub(stubsRoot, path, data)` (**não** é a API antiga `this.generator.run()`)
4. **Stub syntax**: edge-lite — bloco `{{{ exports({ to: app.makePath(...) }) }}}` define destino; interpolação com `{{ var.dotPath }}`. Stubs são assets crus copiados pro dist (nunca compilados).
5. **stubsRoot**: manter o padrão atual `fileURLToPath(new URL('./', import.meta.url))` em `dist/stubs/main.js`.

## Comandos

### 1. `collaboration:init`

Scaffolding one-time (complementa o `configure`, que já publica config):

- Publica rotas REST do contrato do PLAN-client-hooks:
  - `start/routes/collaboration.ts` (stub) com as 8 rotas do contrato
  - `app/controllers/collaboration_controller.ts` (stub) com handlers que delegam pro `CollaborationManager` singleton
- Se engine = partykit: copia o worker template (`stubs/partykit/worker/`) pra `<root>/partykit-worker/` + instrui `npx partykit deploy`
- Publica migration das tabelas base se storage = lucid: `collab_documents`, `collab_versions`, `collab_comments` (schema espelha `CollabComment`/`CollabVersion` de types.ts)
- Flags: `--engine=yjs|automerge|partykit`, `--storage=lucid|file_system|in_memory`

### 2. `make:collab-document <name>`

Gera artefatos por documento/tipo (ex.: `node ace make:collab-document researches/writing`):

- Migration da tabela relacional associada (se `--table` informado) ou apenas registro
- Tipos compartilhados `app/collaboration/documents/<name>_types.ts` (docName pattern, spaces, anchor kinds permitidos)
- Client types exportável (mesmo arquivo, importável pelo front)
- Atualiza (ou cria) registry `app/collaboration/registry.ts` com `defineCollabDocument({...})` — fonte única pra authorize + codegen futuro
- Flags: `--anchors=text-range|canvas-object|timestamp` (multi), `--spaces=text,canvas`

## Escopo

**In:** dois comandos, stubs correspondentes, build pipeline (adonis-kit index), exports map, testes de integração contra app fixture.
**Out:** gerar código de editor frontend (Tiptap config), watch mode, templates customizáveis pelo usuário (custom stubs override).

## Arquivos

| Ação | Caminho |
|---|---|
| criar | `packages/adonis/commands/init.ts` (`CollaborationInit`) |
| criar | `packages/adonis/commands/make_collab_document.ts` |
| criar | `packages/adonis/stubs/collaboration/routes.stub` |
| criar | `packages/adonis/stubs/collaboration/controller.stub` |
| criar | `packages/adonis/stubs/collaboration/migrations/*.stub` (3 tabelas) |
| criar | `packages/adonis/stubs/collaboration/document_types.stub` |
| criar | `packages/adonis/stubs/collaboration/registry.stub` |
| editar | `packages/adonis/tsconfig.build.json` — include `commands/**/*` |
| editar | `packages/adonis/package.json` — script postbuild `adonis-kit index dist/commands`; exports `./commands` → `./dist/commands/main.js`; devDep `adonis-kit` |
| criar | `packages/adonis/dist build helper`: `commands/main.ts` barrel que carrega `commands.json` (copiar padrão do lucid `build/commands/main.js`) |
| editar | `packages/adonis/configure.ts` — `rcFile.addCommand('@adonis-agora/collaboration/commands')` |
| editar | `copy:stubs` script — incluir novos stubs + commands.json handling |
| criar | `packages/adonis/test/codegen.spec.ts` |

## Pipeline de build (ordem)

```
tsc -p tsconfig.build.json        # compila src/ + commands/
adonis-kit index dist/commands    # gera dist/commands.json
pnpm run copy:stubs               # copia .stub + main.js dos stubs
check:dist                        # assert existente continua passando
```

Gotchas ESM mapeados na pesquisa:
- `.stub` nunca entra no tsc (só copy)
- `files: ["dist/"]` já cobre commands.json — nada a mudar
- decorators exigem `experimentalDecorators: true` no tsconfig do pacote (verificar base)

## Critérios de verificação

1. Teste de integração: app fixture Adonis mínimo (como lucid testa) roda `node ace collaboration:init --engine=yjs --storage=lucid` num tmp dir e faz snapshot dos arquivos gerados (rotas, controller, migrations); depois `make:collab-document writing --anchors=text-range` valida registry + types.
2. Comandos aparecem no `node ace --help` do fixture (prova que commands.json + rcFile estão certos).
3. `typecheck && build && check:dist` passam no CI do pacote.
4. Fluxo ponta a ponta documentado no README: configure → init → make:collab-document → hooks client conectando.

## Dependências entre planos

- Depende do **contrato REST do PLAN-client-hooks** (stub de rotas/controller implementa esse contrato).
- Depende do **worker template do PLAN-partykit-driver** (init copia os stubs dele quando `--engine=partykit`).
- Ordem sugerida: client-hooks (contrato) ∥ partykit-driver → codegen por último (consome ambos).

## Riscos

- `adonis-kit index` pode ter drift de API entre versões → pinar devDep; fallback documentado: escrever commands.json manualmente (formato estável).
- Stub de migration precisa bater com o schema real do `LucidStorage` existente (lucid_storage.ts) — revisar colunas contra o modelo antes de implementar.


---

## Decisões finais (pós-implementação)

- Registry de documentos NÃO é mais `app/collaboration/registry.ts` — é `.adonisjs/collaboration/documents.ts`, gerado pelo hook `init` do Assembler (codegen v7), refresh via `node ace codegen`/dev server. `registry.stub` foi removido.
- `adonis-kit` não existe no npm: o `commands.json` (formato version 1 do lucid) é gerado por `scripts/build-commands.mjs`, que lê os estáticos das classes compiladas (`Command.args`/`Command.flags`).
- Contrato REST mudou pra query/body param `?doc=` (docName tem barras) — ver PLAN-client-hooks.
- Teste de integração ace real: `test/ace_integration.spec.ts` boot IgnitorFactory+AceFactory contra fixture tmpdir e executa o comando compilado pelo kernel. Limitação conhecida documentada no spec: a escrita do arquivo via codemods/edge-lite não roda nesse fixture leve; conteúdo é coberto por codegen.spec + codegen_hook.spec.
- make:collab-document usa `startApp: true` (necessário pro app.generators, igual make:migration do lucid).

## Follow-ups explícitos (adiados com justificativa)

- **Automerge client transport**: o contrato atual do client é Y.Doc-centric (Tiptap/awareness). Um transporte Automerge não fornece Y.Doc — exigiria uma segunda API de hooks não-Yjs. Adiado até haver demanda real; server-side automerge segue funcionando.
- **y-partyserver adapter**: sucessor ativo do y-partykit (Cloudflare), mas exige pesquisa própria de API antes de implementar. O driver partykit isola o resto do pacote dessa troca.
