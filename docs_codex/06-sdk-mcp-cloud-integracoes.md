# SDKs, MCP, Cloud e Integrações

## Visão geral

Codex tem múltiplas superfícies de integração:

- Python SDK sobre `codex app-server` via JSON-RPC stdio;
- TypeScript SDK sobre CLI e eventos JSONL;
- app-server como protocolo principal para IDE/desktop/clientes ricos;
- MCP server experimental para controlar o engine Codex local;
- plugin/MCP/app connector ecosystem;
- remote control, environments e cloud tasks.

## Python SDK

O Python SDK é descrito como forma de iniciar threads Codex, rodar turns, streamar progresso e controlar acesso ao workspace (`.referece/codex/sdk/python/README.md:1-4`). Ele reusa auth existente, cria client `Codex`, inicia thread e roda turn; `thread.run(...)` retorna `TurnResult` com final response, items coletados e token usage (`.referece/codex/sdk/python/README.md:16-29`).

Auth inclui browser login, device-code login e API-key login (`.referece/codex/sdk/python/README.md:31-59`). Exportações públicas incluem `Codex`, `AsyncCodex`, `Thread`, `AsyncThread`, login handles, sandbox controls, input types e errors (`.referece/codex/sdk/python/src/openai_codex/__init__.py:16-54`).

A API síncrona `Codex` cobre criação de thread, login, account/session access e lifecycle. `thread_start` aceita model, sandbox, cwd, personality, service tier, thread source e session-start metadata (`.referece/codex/sdk/python/src/openai_codex/api.py:75-170`). Também há `thread_resume`, `thread_fork`, `thread_archive` e `thread_unarchive` (`.referece/codex/sdk/python/src/openai_codex/api.py:201-279`).

`CodexClient` é JSON-RPC typed client para `codex app-server` sobre stdio: spawna processo app-server, envia `initialize` e depois `initialized` (`.referece/codex/sdk/python/src/openai_codex/client.py:212-309`). O client roteia notifications globais e scoped de login, turn e goal operations (`.referece/codex/sdk/python/src/openai_codex/client.py:311-388`). Métodos mapeiam para account login/logout, thread start/resume/list/read/fork/archive/unarchive, naming, compaction e goals (`.referece/codex/sdk/python/src/openai_codex/client.py:393-549`).

Testes validam que `Thread.run` cruza a fronteira app-server, preserva model overrides/usage, suporta async e streaming, e propaga API-key/ChatGPT tokens para requests (`.referece/codex/sdk/python/tests/test_app_server_run.py:24-145`, `.referece/codex/sdk/python/tests/test_app_server_streaming.py:22-167`, `.referece/codex/sdk/python/tests/test_app_server_login.py:22-90`).

## TypeScript SDK

O TypeScript SDK encapsula o CLI `codex` e troca eventos JSONL por stdin/stdout (`.referece/codex/sdk/typescript/README.md:1-6`). Ele suporta criar thread e rodar múltiplos turns na mesma thread (`.referece/codex/sdk/typescript/README.md:15-32`). Streaming é exposto via eventos estruturados de `runStreamed()` (`.referece/codex/sdk/typescript/README.md:34-51`).

Também suporta structured output via JSON schema ou schemas derivados de Zod (`.referece/codex/sdk/typescript/README.md:53-84`), imagens locais, resume de threads salvas, working directory, controle de environment e `--config` overrides (`.referece/codex/sdk/typescript/README.md:86-149`).

## App-server

O app-server é a superfície principal para clientes ricos. Ele roda JSON-RPC 2.0 similar a MCP e suporta stdio, websocket experimental, unix socket e off (`.referece/codex/codex-rs/app-server/README.md:20-29`). O unix socket é control-plane local; `codex app-server proxy` conecta socket a stdin/stdout (`.referece/codex/codex-rs/app-server/README.md:39-42`).

Backpressure é explícito: filas bounded e erro JSON-RPC `-32001` quando ingress está saturado, considerado retryable (`.referece/codex/codex-rs/app-server/README.md:49-53`). O server pode gerar TypeScript schema e JSON Schema do protocolo (`.referece/codex/codex-rs/app-server/README.md:55-62`).

Primitivas: Thread, Turn e Item (`.referece/codex/codex-rs/app-server/README.md:64-72`). Lifecycle: initialize → thread start/resume/fork → turn start → stream notifications → turn completion (`.referece/codex/codex-rs/app-server/README.md:74-82`).

`thread/start`, `thread/resume` e `thread/fork` aceitam permissions, sandbox compatibility, runtime workspace roots, sticky environments, selected capability roots e MCP routing (`.referece/codex/codex-rs/app-server/README.md:138-150`). `turn/start` dispara geração e streama eventos de turno/item (`.referece/codex/codex-rs/app-server/README.md:171-180`).

## App-server client in-process

`app-server-client` existe para superfícies conversacionais internas como `codex-exec` e `codex-tui`, centralizando bootstrap, lifecycle e shutdown (`.referece/codex/codex-rs/app-server-client/README.md:3-17`). A identidade de startup é passada via `SessionSource` e `client_info.name`, preservando proveniência em `thread/list` e `thread/read` (`.referece/codex/codex-rs/app-server-client/README.md:20-25`).

O transporte in-process usa typed channels internamente, preservando semântica JSON-RPC na borda de resposta (`.referece/codex/codex-rs/app-server-client/README.md:29-43`). Backpressure/shutdown também são bounded (`.referece/codex/codex-rs/app-server-client/README.md:58-67`).

## Codex MCP server interface

Codex tem MCP server experimental: JSON-RPC sobre transporte MCP stdio para controlar engine local (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:1-8`). Ele expõe métodos para threads, turns, accounts, config e approvals; tipos vivem em `app-server-protocol/src/protocol/{common,v1,v2}.rs` e são consumidos por app-server (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:9-33`).

RPCs v2 principais incluem `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt`, account login/logout/rate limits, config read/write, model/list, app/list e collaborationMode/list (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:15-21`). Compatibilidade v1 mantém summary/auth/gitDiff/fuzzyFileSearch (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:21-29`).

Durante conversas, o server envia notificações `codex/event`, `fuzzyFileSearch/*` e deve surfacear approval requests (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:95-103`). Tool responses `codex` e `codex-reply` retornam `CallToolResult` padrão MCP e espelham content em `structuredContent` com `threadId` (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:104-118`). Approvals server→client incluem `applyPatchApproval` e `execCommandApproval`; cliente responde `allow` ou `deny` (`.referece/codex/codex-rs/docs/codex_mcp_interface.md:120-128`).

## codex-protocol e codex-client

`codex-protocol` define tipos compartilhados para comunicação interna CLI e comunicação externa app-server (`.referece/codex/codex-rs/protocol/README.md:1-8`). `codex-client` é camada de transporte HTTP, retries e SSE streaming, intencionalmente neutra sobre endpoints Codex específicos (`.referece/codex/codex-rs/codex-client/README.md:3-8`).

## Plugins, apps e MCP no app-server

O app-server expõe APIs de `skills/list`, `skills/extraRoots/set`, `hooks/list`, marketplace/plugin install/list/read, app/list, MCP OAuth login, MCP server status/resource/tool call (`.referece/codex/codex-rs/app-server/README.md:210-239`). Isso sugere que clientes ricos podem gerenciar ecossistema de extensões e autenticação de apps sem operar diretamente arquivos internos.

`thread/start` pode receber `selectedCapabilityRoots`; skills abaixo desses roots são listadas/lidas no ambiente dono, stdio MCP servers de plugins selecionados são iniciados nesse ambiente, e conexões HTTP MCP usam HTTP client do ambiente (`.referece/codex/codex-rs/app-server/README.md:138-143`).

## Remote control e environments

O app-server expõe `environment/add`, `environment/info`, remote-control enable/disable/status/pairing/client revoke e status changed (`.referece/codex/codex-rs/app-server/README.md:207-229`). Isso permite controlar ou conectar ambientes remotos/externos e parear dispositivos controladores.

## Cloud tasks

A CLI possui subcomando experimental `cloud`/`cloud-tasks` para navegar tarefas do Codex Cloud e aplicar mudanças localmente (`.referece/codex/codex-rs/cli/src/main.rs:195-197`). Isso reforça a separação entre agente local e produto cloud, com ponte operacional via CLI.

## Pontos notáveis

- Python SDK usa app-server diretamente; TS SDK usa CLI/JSONL.
- App-server é o contrato mais rico e versionável para IDE/desktop.
- MCP server reusa conceitos do app-server e abre Codex como tool/server para outros clientes.
- Integrações carregam provenance/`clientInfo`, importante para compliance e auditoria.
- Plugins, MCP servers, apps e skills são gerenciáveis por API, não apenas por arquivos.
