# Codex CLI — Gap Analysis vs. nosso `code-agent`

| Campo | Valor |
|---|---|
| Data da análise | 2026-05-25 |
| Repo analisado | https://github.com/openai/codex |
| Commit (HEAD) | `8a94430bb273623be42b68f144f1ab1df343bb53` |
| Mensagem | `fix(process-hardening): preserve macos malloc diagnostics (#24479)` |
| Clone local | `D:\MCP\.reference\codex` (gitignored) |
| Nosso core analisado | `packages/code-agent/` |

Este documento confronta as tools que o **OpenAI Codex CLI** expõe ao modelo com as do nosso agente, e propõe quais vale a pena absorver. **Nenhuma alteração foi feita** em `packages/code-agent` durante esta análise — o doc é insumo para decidir PRs futuros.

---

## TL;DR

- Cobrimos **a maior parte das primitivas do Codex** e ainda temos várias que ele não tem (LSP, worktrees, company, skills, RAG, tier system).
- **`apply_patch`**: descoberta tardia — JÁ EXISTE em [packages/code-agent/src/tools/apply-patch.ts](../../packages/code-agent/src/tools/apply-patch.ts), formato V4A completo, registrado só p/ ChatGPT. Decisão: deixar como está.
- **`exec_command` + `write_stdin`**: implementado em 2026-05-26 — [packages/code-agent/src/tools/exec-command.ts](../../packages/code-agent/src/tools/exec-command.ts).
- **`followup_task`**: implementado em 2026-05-26 como wrapper fino sobre `send_message` — [packages/code-agent/src/tools/followup-task.ts](../../packages/code-agent/src/tools/followup-task.ts).
- **Postponed**: `request_permissions` (Tier A) ficou para sessão futura.
- **Não adotar**: sandbox seatbelt/landlock (específico Unix), `image_generation` (fora de escopo IDE), `dynamic` (runtime tool registration — caro vs. ganho).

---

## Inventário canônico das tools do Codex

Extraído de `.reference/codex/codex-rs/core/src/tools/handlers/` + `spec_plan.rs`. Não inclui specs de teste (`*_tests.rs`, `*_spec.rs`).

### Edits & Shell
| Tool Codex | Arquivo no Codex | Nosso equivalente | Status |
|---|---|---|---|
| `apply_patch` | `handlers/apply_patch.rs` + `apply_patch.lark` | `tools/apply-patch.ts` (formato V4A completo, CRLF/BOM handling, two-phase commit) | ✅ (registrado apenas para ChatGPT em [index.ts:364](../../packages/code-agent/src/index.ts)) |
| `shell_command` (one-shot) | `handlers/shell.rs` | `tools/shell.ts` (`run_command`) | ✅ |
| `exec_command` + `write_stdin` (sessão persistente) | `handlers/unified_exec/{exec_command,write_stdin}.rs` | `tools/exec-command.ts` (process registry, pipe + opt-in pty, TTL eviction) | ✅ (implementado 2026-05-26) |

### Planning, Goals, UX
| Tool Codex | Arquivo no Codex | Nosso equivalente | Status |
|---|---|---|---|
| `plan` | `handlers/plan.rs` | `tools/plan.ts` (`submit_plan`) | ✅ |
| `get_goal` / `create_goal` / `update_goal` | `handlers/goal.rs` | `tools/goal.ts` | ✅ |
| `request_user_input` | `handlers/request_user_input.rs` | `tools/interaction.ts` (`ask_user`) | ✅ |
| `request_permissions` | `handlers/request_permissions.rs` | — | ❌ falta |
| `view_image` | `handlers/view_image.rs` | `tools/view-image.ts` | ✅ |

### Multi-agent
| Tool Codex | Arquivo no Codex | Nosso equivalente | Status |
|---|---|---|---|
| v1: `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent` | `handlers/multi_agents.rs` + `agent_jobs.rs` | `tools/subagent.ts` (`spawn_subagent`, `spawn_agents`, `list_agents`, `wait_agents`) | ✅ |
| v1: `spawn_agents_on_csv`, `report_agent_job_result` | `handlers/agent_jobs.rs` | — | ❌ falta (mas: nosso master/subordinate cobre o caso) |
| v2: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `close_agent`, `list_agents` | `handlers/multi_agents_v2.rs` | `tools/spawn-agent.ts` + `send-message.ts` + `wait-agents.ts` + `list-agents.ts` + `followup-task.ts` | ✅ (followup_task implementado 2026-05-26 como wrapper sobre send_message) |

### MCP, Discovery & Misc
| Tool Codex | Arquivo no Codex | Nosso equivalente | Status |
|---|---|---|---|
| `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` | `handlers/mcp_resource.rs` | `tools/mcp-bridge.ts` (`mcp_list_resources`, `mcp_read_resource`) | 🟡 parcial (sem `templates`) |
| `tool_search` | `handlers/tool_search.rs` | `tools/find-tools.ts` (`find_tools`) | ✅ |
| `web_search` | (handler externo via OpenAI) | `tools/web.ts` (`web_search`) | ✅ |
| `image_generation` | (handler externo via OpenAI) | — | ❌ falta (não prioritário IDE) |
| `test_sync_tool` | `handlers/test_sync.rs` | — | ❌ falta (CI-específico) |
| `code_mode` (execute + wait) | `handlers/code_mode/` | `tools/code-exec.ts` (`code_exec`) | 🟡 parcial (não composável como modo) |
| `dynamic` (runtime tool registration) | `handlers/dynamic.rs` | — | ❌ falta (skills cobrem parcialmente) |
| `extension_tools` | `handlers/extension_tools.rs` | (MCP externos + skills) | 🟡 parcial |
| `list_available_plugins_to_install` + `request_plugin_install` | `handlers/list_available_plugins_to_install.rs`, `handlers/request_plugin_install.rs` | — | ❌ falta (marketplace futuro) |

### Tools que NÓS temos e Codex NÃO tem
- LSP integration (`lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_diagnostics`)
- Worktrees (`enter_worktree`, `exit_worktree`)
- Company orchestration (master/subordinate, kanban, pipelines)
- Skills framework (`invoke_skill`, `list_skill_namespaces`)
- RAG (`rag_search_docs`)
- Plan/tasks approval gating com `submit_tasks`, `execute_task`, `task_complete`, `update_task`
- Tier system (`expand_toolset`)
- Quality classifier (policy enforcement no nível do loop)
- Output recovery (`get_tool_output`)

---

## Recomendação de adoção

### Tier S — DONE

**1. `apply_patch` (formato V4A + grammar Lark)** — ✅ DISPONÍVEL PARA TODOS OS PROVIDERS (2026-05-26)
- Vive em [packages/code-agent/src/tools/apply-patch.ts](../../packages/code-agent/src/tools/apply-patch.ts) (525 linhas, formato V4A completo, CRLF/BOM handling no Windows, two-phase commit que valida todos os hunks antes de qualquer write).
- **2026-05-26**: gate `if (provider.name === 'chatgpt')` removido. Agora registrado para todos os providers. Para ChatGPT/Codex com `apply_patch_tool_type === 'freeform'`, o wire é `type: 'custom'` (raw patch text). Para outros (Claude, Gemini), wire é function tool com `patch: string` — handler aceita ambos via `args.patch` ou `args._raw`.
- **Trade-off conhecido**: adiciona ~600 chars no system prompt e cria sobreposição com `edit_file`/`multi_edit`. O modelo decide qual usar com base na description. Confirmar com benchmark se houver regressão de tool-choice em modelos não-ChatGPT.

**2. `exec_command` + `write_stdin` (sessão shell persistente)** — ✅ IMPLEMENTADO 2026-05-26
- Vive em [packages/code-agent/src/tools/exec-command.ts](../../packages/code-agent/src/tools/exec-command.ts) (~420 linhas). Registrado em [index.ts](../../packages/code-agent/src/index.ts) logo após `ptyTools`.
- **Design**:
  - Process registry (module-level `Map<sessionId, SessionRecord>`) — sessões sobrevivem entre tool calls.
  - 2 transports: `pipe` (default, `child_process.spawn`) e `pty` (opt-in via `tty: true`, dynamic-import `node-pty`).
  - TTL idle de 10 min + cap de 16 sessões abertas (LRU eviction).
  - Yield model do Codex: `yield_time_ms` decide quanto esperar antes de retornar; resposta inclui `session_id`, `status`, output incremental.
  - `write_stdin` com `chars=""` funciona como poll não-destrutivo.
- **Diferenças vs. Codex**: sem permission profiles (não temos infra), sem `environment_id`, sem login shells (Windows/cross-platform).
- **Verificação**: pendente — testar com `node` REPL, `python -i`, `npm init`. Ver seção Verificação.

### Tier A — DONE (parcial)

**3. `request_permissions`** — ⏸️ POSTPONED (ignorado por ora)
- Decisão do usuário em 2026-05-26: pular nesta rodada. Volta a entrar em pauta quando aparecer fluxo real que precise de grant escopado.

**4. Semântica `followup_task` para multi-agent** — ✅ IMPLEMENTADO 2026-05-26
- Vive em [packages/code-agent/src/tools/followup-task.ts](../../packages/code-agent/src/tools/followup-task.ts). Wrapper fino sobre `sendMessage.handler` com framing `[Follow-up task]: ${task}`.
- Razão da separação: o modelo escolhe tools pelo nome+descrição antes de ler o corpo. Ter `followup_task` distinto de `send_message` deixa a intenção de orquestração legível no tool-call log do master.
- **Sem mudanças** em `send_message`/`send_input` — `followup_task` reaproveita 100% do transport existente.

### Tier B — não adotado nesta rodada
- **Como**: rename + ajuste de system prompt em `tools/subagent.ts`. Manter compat retro temporária.
- **Custo**: <1 dia.

### Tier B — observar / adiar

- **`code_mode`** (execute + wait composável): `code_exec` nosso já existe; só refatorar se virar gargalo.
- **`dynamic`** (runtime tool registration): poderoso, mas exige infra de validação/sandbox. Skills cobrem 80%. Adiar.
- **`test_sync_tool`**: CI orchestration específico — não é prioridade IDE.
- **`request_plugin_install` + `list_available_plugins_to_install`**: marketplace é projeto à parte (não é o trabalho de agora).
- **`image_generation`**: fora de escopo IDE coder.

### Não adotar

- **Sandbox seatbelt/landlock**: específico macOS/Linux. No Windows precisaríamos AppContainer + Job Objects — projeto separado de várias semanas. Hoje cobrimos via plan-mode/policy/tier (insuficiente vs. nível kernel, mas suficiente para o uso atual).
- **Permission profiles com herança**: nosso tier system + `expand_toolset` já cobre.
- **`mcp_resource_templates`** (variante): MCP overhead que não usamos hoje; adicionar só quando algum server MCP exigir.

---

## Diferenciais arquiteturais do Codex (referência rápida)

- **Sandbox por OS**: seatbelt (macOS), landlock (Linux), Windows sandbox via container — `handlers/sandboxing.rs`.
- **Permission profiles** com herança e Windows sandbox integration.
- **Apply-patch com grammar formal** (Lark) — parser determinístico em vez de regex.
- **Plugins / extensions** com lifecycle hooks (instalação em runtime).
- **Python SDK** com auth first-class (API key + device-code).
- **Servidor MCP experimental**: Codex também atua como **MCP server**, permitindo que outros agentes o invoquem como tool. Nosso lado: somos cliente MCP, não servidor.

---

## Implementation log

| Data | Tool | Arquivo | Notas |
|---|---|---|---|
| 2026-05-26 | `exec_command` + `write_stdin` | [tools/exec-command.ts](../../packages/code-agent/src/tools/exec-command.ts) | Process registry, pipe + opt-in pty, TTL 10min, max 16 sessões |
| 2026-05-26 | `followup_task` | [tools/followup-task.ts](../../packages/code-agent/src/tools/followup-task.ts) | Wrapper sobre `send_message` com framing `[Follow-up task]:` |
| 2026-05-26 | Verificação `exec_command` | [tools/__tests__/exec-command.test.ts](../../packages/code-agent/src/tools/__tests__/exec-command.test.ts) | 7 testes integration, todos passando: spawn one-shot, sessão long-running, multi-turn write_stdin, poll não-destrutivo, truncation cap, erros |
| 2026-05-26 | `apply_patch` liberado para todos os providers | [index.ts:369-377](../../packages/code-agent/src/index.ts) | Removido gate `if (provider.name === 'chatgpt')`. ChatGPT continua usando wire `type: 'custom'`; demais usam function tool com `patch: string` |
| 2026-05-26 | Doc atualizado | este arquivo | Reclassificação após descoberta de `apply_patch` já implementado |

## Próximos passos

1. ~~**Verificar `exec_command` em uso real**~~ — ✅ DONE 2026-05-26 (vitest integration suite, 7/7 passing).
2. **`request_permissions`** (Tier A postponed): reabrir quando aparecer fluxo de admin-tier que precise de grant escopado por turn. Hoje o tier system + plan-gating cobre.
3. ~~**`apply_patch` para Claude também?**~~ — ✅ DONE 2026-05-26. Gate removido; tool registrada para todos. Acompanhar uso real em sessões Claude/Gemini — se modelo escolher `apply_patch` mas falhar por JSON-escaping de patches grandes, considerar registrar como `apply_patch_with_raw` ou expor `_raw` channel.

Arquivos críticos do nosso lado (tools mencionadas):
- [packages/code-agent/src/tools/apply-patch.ts](../../packages/code-agent/src/tools/apply-patch.ts) — apply_patch V4A
- [packages/code-agent/src/tools/exec-command.ts](../../packages/code-agent/src/tools/exec-command.ts) — exec_command + write_stdin
- [packages/code-agent/src/tools/followup-task.ts](../../packages/code-agent/src/tools/followup-task.ts) — followup_task
- [packages/code-agent/src/tools/send-message.ts](../../packages/code-agent/src/tools/send-message.ts) — backing transport
- [packages/code-agent/src/tools/pty.ts](../../packages/code-agent/src/tools/pty.ts) — run_command_pty (one-shot, complementar)
- [packages/code-agent/src/index.ts](../../packages/code-agent/src/index.ts) — registro

Arquivos críticos do lado Codex (após clone):
- `.reference/codex/codex-rs/core/src/tools/handlers/apply_patch.rs` + `apply_patch.lark`
- `.reference/codex/codex-rs/core/src/tools/handlers/unified_exec.rs`
- `.reference/codex/codex-rs/core/src/tools/handlers/request_permissions.rs`
- `.reference/codex/codex-rs/core/src/tools/handlers/multi_agents_v2.rs`
- `.reference/codex/codex-rs/core/src/tools/spec_plan.rs` — todas as specs JSON-schema das tools
