# Arquitetura e Runtime do Projeto

## Visão geral

O projeto é um monorepo TypeScript/React/Electron/Cloudflare. O workspace PNPM inclui `packages/*` e `services/*` (`pnpm-workspace.yaml:1-4`). O `package.json` declara Node `>=22.12.0`, entrypoint Electron em `dist/apps/electron/main.js` e bins `mcp-code-indexer` e `mcp-code-indexer-server` (`package.json:6-13`).

Os scripts raiz cobrem build TypeScript, Vite dashboard/portal, Electron dev/build, Hono API, CLI/MCP server, Vitest, typecheck e checagens arquiteturais (`package.json:14-49`).

## Layout macro

A própria documentação do projeto resume as responsabilidades (`README.md:62-93`):

- `apps/dashboard`: React SPA.
- `apps/electron`: desktop runtime com backend in-process e renderer.
- `apps/http-api`: Hono adapter para HTTP/SSE/WebSocket.
- `packages/api-bus`: contrato de API transport-agnostic.
- `packages/api-handlers`: handlers puros reutilizáveis.
- `packages/store`: SQLite, WAL e migrations.
- `packages/code-agent`: runtime de agente/coder.
- `worker/`: Cloudflare embeddings worker.
- Cloud/license/billing workers e pacotes correlatos.

A documentação principal mapeada pelo README inclui `docs/ARCHITECTURE.md`, `docs/IDE_WORKSPACE.md`, `docs/ELECTRON_DEV.md`, `docs/INDEXER.md` e `docs/PLUGINS.md` (`README.md:95-101`).

## Boundary Electron vs Hono

A arquitetura central é: Electron main cria a janela, importa o backend no mesmo processo e evita loopback HTTP em produção. O dashboard fala via API bus/handlers, e Hono é adaptador, não dono da lógica (`docs/ARCHITECTURE.md:11-58`).

O Electron main explicita esse princípio: ele possui o backend in-process, registra IPC handlers e evita `child_process`/HTTP loopback para a aplicação desktop (`apps/electron/main.ts:2-18`). Durante boot, cria o backend com `createApp()`, opcionalmente inicia HTTP de dev, instala hardening e monta pontes de IPC, terminal, secrets, window, OAuth e protocolo (`apps/electron/main.ts:219-265`).

Em dev, `apps/electron/dev.ts` roda o main por `tsx`, pré-compila `preload.cjs` e aponta para o Vite dashboard dev server (`apps/electron/dev.ts:2-20`). O ambiente dev injeta `MCP_ELECTRON_DEV_URL`, desabilita HTTP salvo `MCP_DEV_HTTP=1` e injeta loader `tsx` (`apps/electron/dev.ts:71-86`).

## Protocolo local `mcp://`

Electron registra protocolo custom `mcp://` para que o renderer use `fetch()` contra o backend sem sockets, preservando respostas streaming (`apps/electron/main.ts:127-159`). O dashboard resolve a base para `mcp://app` dentro do Electron e URLs relativas no browser dev (`apps/dashboard/lib/api-client.ts:143-149`).

## Hono HTTP API

`apps/http-api/server.ts` é a camada de transporte HTTP (`apps/http-api/server.ts:1-3`). Ele monta rotas de projects, search, files, graph, snapshots, runs, diff, costs, webhooks, export, models, stats, telemetry, coder, LSP, editor, project git, terminal WS, workspace, docs, docs-agent, design-system, config, auth/OAuth, admin e company streams (`apps/http-api/server.ts:5-41`).

O server compõe singletons e stores de provider/policy com serviços de `@mcp/services`, `@mcp/code-agent`, `@mcp/company`, `@mcp/docs-agent`, `@mcp/indexer` e `@mcp/store` (`apps/http-api/server.ts:46-69`). Também inicializa LSP executors e worker pools (`apps/http-api/server.ts:138-159`).

Company auto-resume tem comportamento por runtime: habilitado por padrão em Node/server, desabilitado por padrão em Electron salvo override (`apps/http-api/server.ts:221-247`).

## API bus e handlers

`@mcp/api-bus` é o contrato RPC transport-agnostic, compartilhado por Electron IPC e Hono HTTP/SSE; implementações vivem em `@mcp/api-handlers` (`packages/api-bus/src/index.ts:2-14`). O agregado `Api` enumera namespaces como `coder`, `projects`, `files`, `lsp`, `editor`, `terminal`, `runner`, `snapshots`, `search`, `docs`, `designSystem`, `company`, `workspace`, `auth`, `billing`, `plugins`, `system`, `admin`, `telemetry`, `config`, entre outros (`packages/api-bus/src/index.ts:84-146`).

`@mcp/api-handlers` é a camada pura de implementação, montada por Hono e Electron IPC (`packages/api-handlers/src/index.ts:2-12`). `createHandlers(deps)` retorna um `Partial<Api>` com namespaces já migrados para handlers puros, como `projects`, `files`, `terminal`, `runner`, `runtime`, `coder`, `lsp`, `editor`, `snapshots`, `runs`, `search`, `projectGit`, `plugins` e `system` (`packages/api-handlers/src/index.ts:93-120`). O arquivo documenta que `admin`, `docs`, `designSystem`, `company` e `workspace` ainda usam adaptadores Hono legados (`packages/api-handlers/src/index.ts:97-100`).

Handlers não criam contexto por conta própria; adapters/testes criam `ApiContext` (`packages/api-handlers/src/context.ts:2-6`). `createContext` sintetiza `requestId` e `AbortSignal`, enquanto `createInternalContext` usa usuário interno pro/local para chamadas trusted (`packages/api-handlers/src/context.ts:11-38`).

## Streaming

O contrato de streaming usa `AsyncStream<T>` / `AsyncIterable<T>` como fronteira compartilhada; Electron usa `MessagePort`, Hono usa SSE (`docs/ARCHITECTURE.md:83-95`).

No Electron, o Hono dispatcher in-process transforma IPC em `Request` sintético e chama `app.fetch()` sem listener TCP (`apps/electron/src/hono-dispatch.ts:1-25`). Rotas streaming são detectadas por `accept: text/event-stream`; SSE é parseado em frames IPC tipados (`apps/electron/src/hono-dispatch.ts:22-25`). A lista de paths streaming inclui `coder.stream.*`, `docs.sources.*Stream`, `docs.research.stream`, `company.stream` e `projects.*Stream` (`apps/electron/src/hono-dispatch.ts:56-69`).

`dispatchHono()` mapeia método dotted para rota, chama `app.fetch()`, trata erro estruturado e retorna JSON/texto (`apps/electron/src/hono-dispatch.ts:201-230`). `dispatchStreaming()` consome SSE como async generator (`apps/electron/src/hono-dispatch.ts:232-298`).

## Worker boundaries

`@mcp/worker-pool` é um pool por tipo de worker thread; LSP atualmente roda in-process (`docs/ARCHITECTURE.md:106-113`). O server HTTP inicializa executors LSP e worker pools durante bootstrap (`apps/http-api/server.ts:138-159`). Company orchestrator no HTTP/API usa worker-thread-backed orchestrators sem fallback in-process; boot falha se o worker não for resolvido (`apps/http-api/sse/companyOrchestrator.ts:1-12`).

## Entrypoints CLI e MCP server

A CLI é um programa `commander` que registra subcomandos e usa nome/versão compartilhados (`apps/cli/index.ts:1-16`). O MCP server stdio usa o SDK MCP, importa snapshot backfill e cleanup de recursos do indexer (`apps/mcp-server/index.ts:1-18`). Após startup, roda reconciliação de snapshot embeddings em background (`apps/mcp-server/index.ts:23-52`) e expõe tools/resources via stdio, drenando recursos no shutdown (`apps/mcp-server/index.ts:54-130`).

## MCP HTTP transport

O transporte MCP HTTP é separado do stdio e expõe a tool registry por Streamable HTTP quando habilitado (`apps/mcp-server/http/mcp-http-transport.ts:1-12`). `createMcpHttpApp()` cria um sub-app Hono e roteia tráfego para `transport.handleRequest(...)` (`apps/mcp-server/http/mcp-http-transport.ts:94-133`). O modo stateless reusa um transporte por requests; o stateful usa `mcp-session-id` e registra ciclo de vida no `SessionManager` (`apps/mcp-server/http/mcp-http-transport.ts:135-196`). Tool invocation aplica tier filtering, tier/scope enforcement, handler call e audit events de sucesso/denial/error (`apps/mcp-server/http/mcp-http-transport.ts:200-305`).

## Packages centrais

- `@mcp/api-bus`: contrato type-only (`packages/api-bus/package.json:1-9`).
- `@mcp/api-handlers`: handlers puros para projects, files, terminal, coder, plugins etc. (`packages/api-handlers/package.json:1-16`).
- `@mcp/store`: persistência SQLite (`packages/store/package.json:1-12`).
- `@mcp/code-agent`: runtime agent, depende de store, db-drivers, services, provider SDK e candidate pipeline (`packages/code-agent/package.json:1-17`).
- `@mcp/services`: camada compartilhada de providers, store e helpers runtime (`packages/services/package.json:1-27`).

## Plugin system na arquitetura

A documentação define plugins compatíveis com Claude Code/Codex plugin spec (`docs/PLUGINS.md:1-18`). Um plugin contém manifest, `.app.json` gerado, MCP/skills opcionais, source bundle, worker bundle e artifacts de webview (`docs/PLUGINS.md:19-38`). O flow instala/materializa namespace, captura snapshot de contribuições, executa worker-thread e expõe namespace `plugins` na API (`docs/PLUGINS.md:99-118`). O hosted market usa Cloudflare Worker com D1/R2 e bundles assinados Ed25519 (`docs/PLUGINS.md:202-225`).

## Resumo de boundaries

- Desktop: Electron main + backend in-process + `mcp://`.
- Browser/dev: Hono HTTP/SSE/WebSocket.
- Programático: API bus/handlers e MCP server.
- Long-running/multi-agent: company worker orchestrators.
- Indexação: indexer + store + worker pools.
- Cloud: contrato separado em `packages/api-bus/src/cloud/contract.ts`, transportado pelo Electron cloud client.
