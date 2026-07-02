# Arquitetura e Runtime do Codex

## Visão geral

O repositório clonado é o Codex CLI open-source, descrito como um agente de coding local da OpenAI. O README diferencia claramente CLI local, integração em IDE, desktop app e Codex Web/cloud (`.referece/codex/README.md:1-8`). A execução a partir do código fonte é centrada no workspace Rust em `codex-rs/`, usando `cargo build` ou `cargo run --bin codex -- ...` (`.referece/codex/docs/install.md:15-49`).

A raiz contém um `package.json`, mas ele é mais um wrapper/monorepo JS para distribuição e tooling; o runtime principal não é Node (`.referece/codex/package.json:1-9`).

## Layout principal

- `codex-rs/`: workspace Rust principal.
- `codex-cli/`: wrapper npm/Node que seleciona o binário nativo por plataforma.
- `sdk/python/`: SDK Python sobre `codex app-server`.
- `sdk/typescript/`: SDK TypeScript sobre CLI/eventos JSONL.
- `docs/`: documentação pública/ponte para docs externas.
- `tools/`: ferramentas auxiliares do repo, como lint de comentários de argumentos.

O workspace Rust lista mais de uma centena de crates, incluindo `cli`, `core`, `protocol`, `app-server`, `tui`, `codex-client`, `codex-api`, `model-provider`, `sandboxing`, `mcp-server`, `state`, `thread-store`, `rollout` e muitos utilitários (`.referece/codex/codex-rs/Cargo.toml:1-126`). A tabela de dependências do workspace padroniza o prefixo `codex-*` e compartilha crates entre pacotes (`.referece/codex/codex-rs/Cargo.toml:138-259`).

## Entry point: `codex`

O crate `codex-cli` constrói o binário principal `codex` e também expõe uma lib `codex_cli` (`.referece/codex/codex-rs/cli/Cargo.toml:1-15`). Suas dependências incluem o núcleo e superfícies principais: `codex-core`, `codex-tui`, `codex-protocol`, `codex-model-provider`, `codex-models-manager`, `codex-state`, `codex-mcp`, `codex-exec`, `codex-sandboxing`, `codex-login` e app-server/client (`.referece/codex/codex-rs/cli/Cargo.toml:20-88`).

A CLI é um roteador amplo. Sem subcomando, as opções são encaminhadas para a CLI interativa/TUI (`.referece/codex/codex-rs/cli/src/main.rs:91-120`). Subcomandos relevantes (`.referece/codex/codex-rs/cli/src/main.rs:123-212`):

- `exec`: execução não interativa;
- `review`: revisão de código não interativa;
- `login` / `logout`: auth;
- `mcp`: gestão de servidores MCP externos;
- `plugin`: gestão de plugins;
- `mcp-server`: inicia Codex como servidor MCP;
- `app-server`: inicia interface JSON-RPC rica;
- `remote-control`: controle remoto experimental;
- `app`: desktop app em macOS/Windows;
- `doctor`: diagnóstico local;
- `sandbox`: executa comandos em sandbox Codex;
- `apply`: aplica último diff produzido pelo agente;
- `resume`, `archive`, `delete`, `unarchive`, `fork`: operações de sessão;
- `cloud`: tarefas Codex Cloud;
- `responses-api-proxy`, `stdio-to-uds`, `exec-server`, `features`.

## Núcleo: `codex-core`

`codex-core` é a biblioteca central de runtime. O manifesto mostra dependências de modeling, protocol, rollout/session storage, sandboxing, MCP, exec server, plugins, hooks, git, telemetry e networking (`.referece/codex/codex-rs/core/Cargo.toml:1-123`).

A lib é dividida em módulos para client/session, rollout, prompts, sandbox, skills, MCP, plugins, thread management, state DB bridge, network proxy loader, exec policy e abstrações de modelo/cliente (`.referece/codex/codex-rs/core/src/lib.rs:1-207`). Ela expõe `session`, `ThreadManager`, `CodexThread`, `TurnContext`, `build_models_manager` e helpers de thread store (`.referece/codex/codex-rs/core/src/lib.rs:17-33`, `.referece/codex/codex-rs/core/src/lib.rs:113-123`).

### ThreadManager

`ThreadManager` é uma fronteira de orquestração importante. Ele mantém estado de threads em memória e recebe dependências como `AuthManager`, models manager compartilhado, environment manager, skills service, plugins manager, MCP manager, thread store, agent graph store, attestation, time provider e analytics (`.referece/codex/codex-rs/core/src/thread_manager.rs:180-260`).

Ele constrói o models manager a partir de `Config` e auth; escolhe armazenamento local SQLite-backed ou in-memory com base em `experimental_thread_store`; e cria agent-graph store local quando há state DB (`.referece/codex/codex-rs/core/src/thread_manager.rs:262-301`). Na criação, inicializa plugins, MCP, skills e code-mode session provider, escolhendo provider in-process ou process-owned por feature flag (`.referece/codex/codex-rs/core/src/thread_manager.rs:305-360`).

### Session

O módulo de sessão importa agent control, environment selection, exec policy, MCP, networking, prompts, rollout, thread store e protocol types (`.referece/codex/codex-rs/core/src/session/mod.rs:1-60`). Ele é subdividido em handlers, input queue, MCP runtime, multi-agents, review, rollout budget, turn context, world state, token budget, entre outros (`.referece/codex/codex-rs/core/src/session/mod.rs:204-243`).

O módulo reexporta `Session`, `SessionConfiguration` e `SessionSettingsUpdate`, mostrando que é dono da configuração e estado concretos da sessão (`.referece/codex/codex-rs/core/src/session/mod.rs:235-238`). Também há erros específicos para steering de input em turno ativo, incluindo turno inexistente, ID divergente, tipo não steerable e input vazio (`.referece/codex/codex-rs/core/src/session/mod.rs:249-285`).

## Modelo de protocolo

`codex-protocol` contém tipos compartilhados: auth, approvals, config, dynamic tools, items, MCP, memory citations, models, network policy, shell env, user input e protocolo principal (`.referece/codex/codex-rs/protocol/src/lib.rs:1-34`).

O próprio protocolo descreve arquitetura de filas assíncronas: **Submission Queue** e **Event Queue** (`.referece/codex/codex-rs/protocol/src/protocol.rs:1-5`). Uma `Submission` carrega ID, operação `Op`, client message id opcional e W3C trace context opcional (`.referece/codex/codex-rs/protocol/src/protocol.rs:159-170`).

`ConversationStartParams` aceita parâmetros de boot como model override, output modality, startup context, prompt, realtime session id, transport, version e voice (`.referece/codex/codex-rs/protocol/src/protocol.rs:193-215`). O realtime é protocolizado com modalidades e vozes (`.referece/codex/codex-rs/protocol/src/protocol.rs:224-322`).

## App-server

`codex-app-server` é crate separado com binário e lib (`.referece/codex/codex-rs/app-server/Cargo.toml:1-18`). Ele depende de core, protocol, transport, exec, backend client, login, models manager, rollout, state, thread store, MCP, hooks, sandboxing e protocolo/transport app-server (`.referece/codex/codex-rs/app-server/Cargo.toml:23-80`).

A biblioteca é dividida em transporte, request processing, config, thread status, model refresh, MCP refresh, skills watcher, message processor e cleanup (`.referece/codex/codex-rs/app-server/src/lib.rs:1-116`). O control-plane separa loop de processamento e loop outbound com `OutboundControlEvent` (`.referece/codex/codex-rs/app-server/src/lib.rs:147-170`). Também possui shutdown gracioso e forced termination (`.referece/codex/codex-rs/app-server/src/lib.rs:191-211`).

A documentação define `codex app-server` como JSON-RPC 2.0 similar a MCP, com transportes stdio, websocket experimental, unix socket e off (`.referece/codex/codex-rs/app-server/README.md:20-29`). O ciclo principal é initialize → thread start/resume/fork → turn start → stream notifications → turn completed (`.referece/codex/codex-rs/app-server/README.md:74-82`).

## Primitivas de domínio

O app-server formaliza três primitivas (`.referece/codex/codex-rs/app-server/README.md:64-72`):

- **Thread**: conversa entre usuário e agente;
- **Turn**: uma rodada, normalmente iniciada por mensagem do usuário e finalizada por mensagem do agente;
- **Item**: unidades persistidas de input/output, incluindo mensagem, reasoning, comando shell, edição etc.

Esse modelo aparece em múltiplas superfícies: TUI, SDKs, app-server, MCP server, persistence e event stream.

## Persistência e rollout

Core expõe primitivas de rollout/session persistence como subdiretórios de sessão, metadata de thread, recorder, parse de session meta, ordenação, lookup de sessões arquivadas (`.referece/codex/codex-rs/core/src/lib.rs:154-175`). O `state` crate é SQLite-backed e espelha metadata de rollouts JSONL em banco local (`.referece/codex/codex-rs/state/src/lib.rs:1-6`).

## Interpretação para comparação

O desenho arquitetural do Codex privilegia:

1. Rust como runtime de baixa latência e controle de sandbox/processos.
2. Contratos de protocolo explícitos para desacoplar UI, SDKs e agente.
3. Uma fronteira `ThreadManager`/`Session` como dono de ciclo de vida.
4. App-server como control-plane único para clientes ricos.
5. Tooling extensível via MCP, plugins, skills, dynamic tools e feature flags.
