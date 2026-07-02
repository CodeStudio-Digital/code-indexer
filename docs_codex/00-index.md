# Investigação do OpenAI Codex

Referência clonada em: `.referece/codex`  
Repositório upstream: <https://github.com/openai/codex>  
Commit investigado: `beca198b8a`

## Objetivo

Este diretório registra uma investigação técnica do Codex para comparação posterior com a ferramenta atual. O foco foi entender como o projeto organiza arquitetura, runtime, tools, prompts, UI, configuração, sandbox, autenticação, SDKs e integrações externas.

## Documentos

- [01-arquitetura-runtime.md](./01-arquitetura-runtime.md) — mapa do repositório, crates principais, entrypoints, runtime, sessão e protocolo.
- [02-tools-e-capacidades.md](./02-tools-e-capacidades.md) — modelo de tools, shell/exec, apply_patch, tool search, MCP, plugins, skills, goals, web/image tools e aprovações.
- [03-prompts-e-instrucoes.md](./03-prompts-e-instrucoes.md) — templates de instrução, personalidade, permissões, sandbox, goals, compaction, review, realtime, AGENTS.md, skills/plugins.
- [04-ui-cli-tui-app.md](./04-ui-cli-tui-app.md) — CLI, wrapper npm, TUI, bottom pane, slash/command surfaces, IDE context e app-server como UI protocol.
- [05-config-auth-sandbox-state.md](./05-config-auth-sandbox-state.md) — configuração, autenticação, approval policy, exec policy, sandboxing e persistência local.
- [06-sdk-mcp-cloud-integracoes.md](./06-sdk-mcp-cloud-integracoes.md) — Python/TypeScript SDKs, app-server, MCP server, cloud/remote/control-plane e integrações.
- [07-pontos-de-comparacao.md](./07-pontos-de-comparacao.md) — aspectos a comparar com a ferramenta atual.

## Síntese executiva

Codex é principalmente um workspace Rust em `codex-rs/`, com um wrapper npm/Node para distribuição. O binário `codex` roteia diversas superfícies: TUI interativa, execução não interativa, review, app-server, MCP server, plugin management, sessão, sandbox e update. O runtime central vive em `codex-core`, enquanto `codex-protocol` e `app-server-protocol` estabilizam tipos/eventos usados por CLI, TUI, SDKs e integrações.

O design é orientado a sessões/threads/turns/items. A comunicação agente-cliente é assíncrona, com submissões do usuário e eventos de saída. Ferramentas são modeladas como specs serializáveis, roteadas por handlers/runtimes, e fortemente integradas a sandbox, approvals, guardian review, MCP, plugins, skills e capacidades dinâmicas.

Codex separa bem:

- núcleo de execução: `codex-rs/core`;
- contrato de eventos/tipos: `codex-rs/protocol` e `codex-rs/app-server-protocol`;
- UI terminal: `codex-rs/tui`;
- control-plane rico: `codex-rs/app-server`;
- distribuição npm: `codex-cli`;
- SDK programático: `sdk/python` e `sdk/typescript`;
- extensões/tools: `codex-rs/tools`, `codex-rs/ext/*`, `codex-rs/core/src/tools/*`.

## Observação sobre escopo

A investigação foi feita por leitura estática do repositório clonado e subagentes especializados. Não foi executado o build completo do Codex; a verificação final desta entrega valida clone, estrutura e documentos gerados.