# Configuração, Autenticação, Sandbox, Approvals e Estado

## Configuração

A documentação local de config aponta para docs externas e adiciona nota sobre `requirements.toml` com `allow_managed_hooks_only = true`, usado para comportamento admin-only de hooks (`.referece/codex/docs/config.md:1-15`). A implementação de config é ampla em `codex-rs/config`.

Campos centrais do TOML incluem model selection, approval policy, approvals reviewer, auto-review, shell environment policy, login-shell permission, sandbox mode, workspace-write settings e default permissions profile (`.referece/codex/codex-rs/config/src/config_toml.rs:151-205`). Campos de segurança/permissão incluem permission profiles nomeados, notifications, instructions, toggles de context injection, forced login method, credential store mode, MCP server config, MCP OAuth store, callback port e callback URL (`.referece/codex/codex-rs/config/src/config_toml.rs:205-283`).

Também há settings de ambiente/persistência: model providers, tamanho/fallback de AGENTS.md, limite de tokens de tool output e timeout máximo de background terminal (`.referece/codex/codex-rs/config/src/config_toml.rs:285-303`). Restrições de ChatGPT workspace aceitam ID único ou lista; strings separadas por vírgula são rejeitadas (`.referece/codex/codex-rs/config/src/config_toml.rs:94-133`).

## Config lock

`config_lock` tem version gate e opção de replay permitindo mismatch de versão (`.referece/codex/codex-rs/core/src/config_lock.rs:12-18`). Locks capturam config resolvida e versão do pacote (`.referece/codex/codex-rs/core/src/config_lock.rs:38-44`). O replay compara lock esperado vs atual, rejeita version mismatch quando não permitido e produz diff TOML em mismatch (`.referece/codex/codex-rs/core/src/config_lock.rs:46-74`). Controles debug-only são removidos antes da comparação (`.referece/codex/codex-rs/core/src/config_lock.rs:93-109`).

## Autenticação

O crate `login` exporta auth manager, config, auth dot JSON, keyring backend, device code flow, server de login, API-key login, access-token login, logout/revoke e leitura de env vars (`.referece/codex/codex-rs/login/src/lib.rs:1-59`). Variáveis relevantes incluem `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY` e `OPENAI_API_KEY` (`.referece/codex/codex-rs/login/src/lib.rs:27-39`).

A backend de auth keyring ativa é derivada da feature `SecretAuthStorage` (`.referece/codex/codex-rs/core/src/config/auth_keyring.rs:10-15`). O bootstrap resolve o backend antes de carregar config completa, usando requirements das camadas de config (`.referece/codex/codex-rs/core/src/config/auth_keyring.rs:18-45`).

## Sandbox por plataforma

A README de core documenta expectativas de sandbox por OS:

- macOS usa `/usr/bin/sandbox-exec`; Seatbelt mantém `.git`, target de `gitdir:` e `.codex` read-only sob workspace-write; regras vêm de `SandboxPolicy` (`.referece/codex/codex-rs/core/README.md:21-35`).
- Linux pode usar Landlock para policy legado equivalente; políticas de filesystem split podem usar bubblewrap; há fallback para `bwrap`, recurso bundled, WSL e falhas de user namespace (`.referece/codex/codex-rs/core/README.md:37-64`).
- Windows usa backends de sandbox elevado e restricted-token não elevado, com limites explícitos sobre policies suportadas; policies fracas demais falham fechado (`.referece/codex/codex-rs/core/README.md:65-93`).
- Todos os sistemas devem simular o CLI virtual `apply_patch` via `--codex-run-as-apply-patch` (`.referece/codex/codex-rs/core/README.md:94-99`).

A doc pública local de sandbox aponta para docs externas (`.referece/codex/docs/sandbox.md:1-4`).

## Approvals e exec policy

A doc local de execution policy aponta para docs externas (`.referece/codex/docs/execpolicy.md:1-4`). Internamente, amendments de exec policy são representados como vetores de prefixos de comando que viram allow rules (`.referece/codex/codex-rs/protocol/src/approvals.rs:32-42`). Network approvals são protocolizadas e suportam HTTP, HTTPS, SOCKS5 TCP e SOCKS5 UDP (`.referece/codex/codex-rs/protocol/src/approvals.rs:60-76`).

Guardian assessments modelam ações de command, execve, patch, network access, MCP tool call e request-permissions review (`.referece/codex/codex-rs/protocol/src/approvals.rs:103-170`). Exec approval requests carregam environment id opcional, command vector, cwd, retry reason opcional, network approval context e amendment proposto de execpolicy (`.referece/codex/codex-rs/protocol/src/approvals.rs:217-258`).

A lógica de sandboxing para tools cacheia decisões por chave serializada em memória na sessão atual (`.referece/codex/codex-rs/core/src/tools/sandboxing.rs:41-64`). O contexto de approval inclui session, turn, call ID, guardian review ID, retry reason e network approval context (`.referece/codex/codex-rs/core/src/tools/sandboxing.rs:120-134`).

Exec approval tem três resultados: skip, needs approval ou forbidden. Skip pode carregar `bypass_sandbox` e execpolicy amendment (`.referece/codex/codex-rs/core/src/tools/sandboxing.rs:160-180`). A lógica default depende de `AskForApproval` e tipo de filesystem sandbox: `Never` pula, `OnRequest`/`Granular` pedem approval só em sandbox restrita, `UnlessTrusted` sempre pergunta; granular pode ser forbidden quando policy proíbe prompts de sandbox approval (`.referece/codex/codex-rs/core/src/tools/sandboxing.rs:199-240`). O override unsandboxed de primeira tentativa depende explicitamente da policy de filesystem (`.referece/codex/codex-rs/core/src/tools/sandboxing.rs:242-258`).

## request_permissions e prompt de permissões

Além do enforcement, permissões são comunicadas ao modelo via prompt. O prompt inclui sandbox mode, approval policy, writable roots, denied reads e, em modo granular, categorias permitidas/proibidas. Isso reduz ambiguidades para o agente e alinha geração com enforcement.

A tool `request_permissions` existe para pedir permissões de filesystem/network sem conceder diretamente. Isso separa intenção do modelo, revisão/aprovação e execução real.

## Estado e persistência

O crate `state` é SQLite-backed e espelha metadata de rollout JSONL em banco local (`.referece/codex/codex-rs/state/src/lib.rs:1-6`). Ele exige SQLite bundled suficientemente novo para evitar WAL-reset corruption (`.referece/codex/codex-rs/state/src/lib.rs:7-10`). `StateRuntime` é o entrypoint preferido e contém config/métricas; APIs lower-level permanecem para testes (`.referece/codex/codex-rs/state/src/lib.rs:25-33`).

Constantes definem home SQLite, override `CODEX_SQLITE_HOME` e DBs separados para logs, goals, memories e state (`.referece/codex/codex-rs/state/src/lib.rs:94-100`).

## App-server config/security APIs

O app-server expõe APIs para `permissionProfile/list`, `config/read`, `config/value/write`, `config/batchWrite` e `configRequirements/read`. Requirements incluem allowed approval policies, sandbox modes, web search modes, permission profiles, hooks lockdown, remote-control policy, computer use policy, feature pins, residency, defaults de modelo e constraints de network (`.referece/codex/codex-rs/app-server/README.md:202-247`).

## Pontos notáveis

- Configuração é parte do boundary de segurança, não apenas preferência de UI.
- Approvals são modelados em protocolo, prompt e runtime.
- Sandbox é multiplataforma e falha fechado quando não consegue aplicar policy adequada.
- Estado local combina JSONL rollout e SQLite para metadados/query.
- App-server torna config e requirements observáveis/editáveis por clientes ricos.
