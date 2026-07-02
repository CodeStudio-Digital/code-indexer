# Operação, Build e Verificação

## Visão geral

Este documento registra como o projeto é executado, verificado e operado em desenvolvimento/local build. Ele também reúne gotchas importantes observados durante a investigação, especialmente porque a próxima etapa será comparar esta base interna com outra referência externa.

## Scripts raiz

O `package.json` central define os comandos principais (`package.json:14-49`):

- `pnpm run build`: `tsc && tsc-alias && node scripts/copy-prompts.mjs`.
- `pnpm run build:dashboard`: build Vite de `apps/dashboard`.
- `pnpm run build:portal`: build Vite de `apps/account-portal`.
- `pnpm run build:all`: TypeScript + alias + prompts + dashboard.
- `pnpm run build:bundled-plugins`: build de plugins bundled.
- `pnpm run dev:server`: Hono API via `tsx watch apps/http-api/server.ts`.
- `pnpm run dev:dashboard`: Vite dev do dashboard.
- `pnpm run dev`: server + dashboard em paralelo.
- `pnpm run electron:dev`: dashboard dev + Electron dev.
- `pnpm run electron:build`: build Electron.
- `pnpm run test`: Vitest.
- `pnpm run typecheck`: `tsc --noEmit`.
- `pnpm run check:loc`, `check:cycles`, `check:deadcode`, `check:arch`.
- `pnpm run eval`, `eval:strict`, `eval:docs`.

A memória durável do projeto também registra que, após validações de teste, o build relevante é `pnpm run build`.

## Entrypoints operacionais

O package expõe dois binários (`package.json:10-13`):

- `mcp-code-indexer`: CLI compilada em `dist/apps/cli/index.js`.
- `mcp-code-indexer-server`: MCP stdio server compilado em `dist/apps/mcp-server/index.js`.

Também há scripts de start (`package.json:29-31`):

- `pnpm start`: CLI com `node --max-old-space-size=8192 dist/apps/cli/index.js`.
- `pnpm run start:server`: MCP server.
- `pnpm run start:api`: Hono HTTP API.

## Desenvolvimento desktop

Electron dev usa `pnpm run electron:dev`, que roda dashboard dev e `tsx apps/electron/dev.ts` (`package.json:25-26`). O launcher Electron dev roda main por `tsx`, pré-compila `preload.cjs` e aponta para o Vite dashboard dev server (`apps/electron/dev.ts:2-20`). O ambiente injeta `MCP_ELECTRON_DEV_URL`, desabilita HTTP por padrão salvo `MCP_DEV_HTTP=1` e injeta loader `tsx` (`apps/electron/dev.ts:71-86`).

No desktop, Electron main importa backend in-process e evita loopback HTTP em produção (`apps/electron/main.ts:2-18`). O protocolo custom `mcp://` permite `fetch()` no renderer sem socket TCP, preservando streaming (`apps/electron/main.ts:127-159`).

## Desenvolvimento HTTP/browser

`pnpm run dev:server` inicia Hono API e `pnpm run dev:dashboard` inicia o Vite dashboard (`package.json:21-24`). Hono permanece útil para browser dev, API standalone e debugging com `MCP_DEV_HTTP=1`, enquanto Electron produção evita loopback (`docs/ARCHITECTURE.md:168-171`).

O dashboard API client cai para HTTP/EventSource fora do Electron, mas usa IPC/streams no desktop (`apps/dashboard/lib/api-client.ts:1-15`, `apps/dashboard/lib/api-client.ts:185-195`).

## MCP server

O MCP server stdio usa MCP SDK transport, importa backfill de snapshots e cleanup de recursos do indexer (`apps/mcp-server/index.ts:1-18`). Após startup, inicia reconciliação de snapshot embeddings em background (`apps/mcp-server/index.ts:23-52`). Ele expõe handlers de tools/resources via stdio e drena recursos do indexer no shutdown (`apps/mcp-server/index.ts:54-130`).

Também existe transporte MCP HTTP separado, que expõe a tool registry via Streamable HTTP quando habilitado (`apps/mcp-server/http/mcp-http-transport.ts:1-12`). Tool invocation por HTTP aplica tier filtering, scope enforcement, handler call e audit events (`apps/mcp-server/http/mcp-http-transport.ts:200-305`).

## Verificação de agent runtime

Memória durável do projeto registra um comando focado para alterações em subagents, scope semantics, allowlists e spawn logic:

```bash
pnpm exec vitest run packages/code-agent/src/tools/__tests__/micro-agent-profiles.test.ts packages/code-agent/src/tools/__tests__/subagent-allowlist.test.ts packages/code-agent/src/tools/__tests__/execute-tasks-events.test.ts src/__tests__/spawn-agent.test.ts
```

Esse conjunto valida perfis de micro-agent, allowlists, eventos de execute-tasks e spawn-agent.

## Verificação de docs/RAG

`pnpm run eval:docs` executa `scripts/docs-rag-eval.ts` contra um gold-set exemplo (`package.json:48`). O script avalia queries gold nos modos `fts`, `hybrid` e `rerank`, computando success@5, recall@5, nDCG@10 e MRR (`scripts/docs-rag-eval.ts:82-103`). Ele carrega o DB vivo, monta a stack de doc search e pode aplicar gate de recall (`scripts/docs-rag-eval.ts:127-203`).

## Verificação arquitetural

Os comandos de arquitetura são (`package.json:34-38`):

- `pnpm run check:loc`: limite/checagem de LOC.
- `pnpm run check:cycles`: ciclos de import.
- `pnpm run check:deadcode`: Knip.
- `pnpm run check:arch`: combina LOC, cycles e deadcode.

## Build nativo e gotchas

Dependências nativas incluem `better-sqlite3`, `electron`, `esbuild` e `node-pty`, marcadas em `pnpm.onlyBuiltDependencies` (`package.json:163-169`). Scripts específicos:

- `pnpm run better-sqlite3`: rebuild de `better-sqlite3`.
- `pnpm run electron:rebuild`: `electron-rebuild -f -o better-sqlite3`.
- `pnpm run node:rebuild`: rebuild de `better-sqlite3 node-pty`.

A arquitetura documenta que Electron build embute SQLite nativo e requer rebuild para ABI Electron (`docs/ARCHITECTURE.md:139-150`).

## Operação de Company Mode

Company orchestrators no HTTP/API são worker-thread-backed, sem fallback in-process (`apps/http-api/sse/companyOrchestrator.ts:1-12`). O API layer expõe get/has/delete/spawn para pool por `companySessionId` (`apps/http-api/sse/companyOrchestrator.ts:19-55`). Company auto-resume é default-on em Node/server e default-off em Electron, salvo override (`apps/http-api/server.ts:221-247`).

Sandbox provisioning em Company Mode é idempotente e deduplicado com promise em voo, evitando corrida entre resumes duplicados/sub-sessions (`packages/company/src/services/SandboxService.ts:214-334`).

## Operação de plugins/providers

Plugins são relidos a cada run, permitindo install/uninstall/enable sem restart (`packages/plugin-host/src/enabled.ts:1-6`). Provider overlays de plugins são aplicados no server e também em workers, porque worker threads possuem module graph isolado (`apps/http-api/server/plugin-providers.ts:1-57`, `apps/http-api/workers/worker-plugin-providers.ts:1-34`).

Marketplace de plugins pode verificar assinatura Ed25519 quando `MCP_MARKET_PUBKEY` está configurado; bytes não verificados não são extraídos nesse modo (`packages/plugin-host/src/sources/fetch-market.ts:7-12`).

## Segurança e operação cloud

Cloud API usa fail-soft para secrets ausentes: sem Stripe, billing retorna 501; sem share signing, criação de share retorna 501; secrets OAuth/admin/SSO ausentes desabilitam surfaces sensíveis (`services/cloud-api/src/env.ts:27-70`).

Sync é Bearer-protected e entitlement-gated; cliente remove secrets antes de push, e vault records têm limite menor e entitlement específico (`services/cloud-api/src/routes/sync.ts:2-97`). Account deletion apaga blobs R2 antes de DB hard-delete para evitar objetos órfãos (`services/cloud-api/src/routes/account.ts:101-130`).

## Gotchas técnicos consolidados

- `run_command` é metadata `mutates: false`, mas pode mutar; a proteção real em plan mode é o gate interno (`packages/code-agent/src/tools/shell.ts:123-235`).
- `pathScopeMode='enforce-writes'` em subagentes não é sandbox completo; shell permanece warning-only (`packages/code-agent/src/tools/implement-subagent.ts:53-60`).
- Memórias duráveis podem estar stale e devem ser verificadas contra o código atual (`packages/code-agent/src/tools/project-memory-tools.ts:108-184`).
- Project DB split existe, mas mantém schema/migrations centrais para convergência (`packages/store/src/project-db/project-schema.ts:1-33`).
- Company sub-sessions compartilham recursos caros, mas isolam board/agent_runs/master_prompts/inbox (`packages/company/src/orchestrator.ts:85-89`).
- Worker provider overlays são duplicados de propósito por isolamento de module graph em worker threads (`apps/http-api/workers/worker-plugin-providers.ts:1-34`).

## Comando recomendado para validar esta documentação

Como `docs_megabrain` é documentação Markdown nova, a validação direta é estrutural:

1. verificar que todos os arquivos esperados existem;
2. verificar que `00-index.md` referencia todos;
3. verificar tamanho mínimo/conteúdo não vazio;
4. revisar alterações com `self_review` antes de marcar a investigação como concluída.

Para mudanças futuras em código, usar os scripts raiz relevantes, especialmente `pnpm run build`, `pnpm run test`, `pnpm run typecheck` ou o subconjunto Vitest de subagentes quando o domínio for agent runtime.
