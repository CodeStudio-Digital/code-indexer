# Auditoria comparativa: MoonshotAI/kimi-cli vs nosso monorepo

**Data:** 2026-05-25
**Branch:** `feature/ide-mvp`
**Clone analisado:** `.reference/kimi-cli` (shallow @ main, commit do dia)
**Autor:** Maicon (com agente)

## TL;DR

- **5 ideias HIGH** vale considerar: `/init` (gera AGENTS.md), wire protocol JSONL versionado, hooks (server-side + client-side), session fork/checkpoint, `_is_effectively_empty_content_parts` (corrige H2 do bug do KIMI imediatamente).
- **6 ideias MED** estruturais: agent spec YAML com herança, multi-scope skill discovery, approval-runtime com context vars, dynamic injection (`<active-context>` por turno), `with_extra_body` field-merge pra thinking config, builtin functions com prefix `$`.
- **3 LOW**: ACP adapter (Zed/JetBrains), VS Code extension, plugin Zsh — bom marketing mas backlog longe.
- **NÃO copiar**: o Kosong SDK (já temos provider abstraction); a UI shell-mode (temos Electron); o sistema de telemetry (já temos coder_turn_telemetry).
- **Achado crítico p/ bug KIMI**: kosong `_convert_message` (kimi.py:318-329) confirma H2 do plano-pai — Kimi-for-Coding rejeita `content: [{"type":"text","text":""}]` com 400, e considera whitespace-only como vazio também. Nosso provider só compara com `''` literal. **✅ Corrigido junto com H6 (skip empty tool_call deltas)** — ver [kimi-code.ts](packages/code-agent/src/providers/kimi-code.ts) e [__tests__/kimi-code.test.ts](packages/code-agent/src/providers/__tests__/kimi-code.test.ts).

---

## 1. Tabela lado-a-lado

| Área | kimi-cli (Python) | Nosso monorepo (TS) | Gap | Esforço | Valor |
|------|-------------------|---------------------|-----|---------|-------|
| **Provider Kimi/Moonshot** | `kosong.chat_provider.kimi.Kimi` ([kimi.py](.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py)) — dropa `content` quando vazio+tool_calls, normaliza schemas com `ensure_property_types`, suporta `builtin_function` (prefix `$`) | [kimi-code.ts](packages/code-agent/src/providers/kimi-code.ts) — compara content só com `''`, normaliza schema mas sem builtin functions | **Bug ativo** (H2 do plano) | S | ⭐⭐⭐ |
| **Multi-provider** | 7 tipos: kimi, openai_legacy, openai_responses, anthropic, gemini, vertexai, _echo/_chaos | 7 providers: anthropic, openai, zai, gemini, deepseek, kimi-code, bedrock, claude-code | Empate — eles têm `_chaos` (fault injection testing) que falta pra nós | M | ⭐⭐ |
| **Agent profiles** | YAML inheritance via `extend:`, default + okabe + subagents (coder, explore, plan) ([agents/](.reference/kimi-cli/src/kimi_cli/agents)) | 5 profiles hard-coded em TS: explore/plan/build/admin/spec | Eles: declarativo + extensível por usuário; nosso: code-bound | M | ⭐⭐ |
| **System prompt** | Jinja2 + builtin vars (KIMI_NOW, KIMI_WORK_DIR, KIMI_SKILLS) ([init.md](.reference/kimi-cli/src/kimi_cli/prompts/init.md)) | Composer TS com `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` por cache; per-provider preambles | Nós temos cache stratification melhor; eles têm templating user-extensível | L | ⭐ |
| **Tools** | `tools/` ~12 tools: agent, shell, file, web, ask_user, todo, background, plan, dmail, think, test | 40+ tools incluindo MCP bridge, LSP, git, snapshots, sandbox, company orchestration | Nós cobrimos muito mais. Falta-nos: `dmail` (mensagem entre agents), `background` tool (long-running em subprocess) | — | — |
| **Compactação** | `compact.md` prompt rígido (XML-like 6 seções: current_focus, environment, completed_tasks, active_issues, code_state, important_context) + `SimpleCompaction` ([kimisoul.py:180](.reference/kimi-cli/src/kimi_cli/soul/kimisoul.py:180)) | `compactMessages` 1000+ LOC, rolling reduction, elision de read-outputs duplicados | Nós: mais sofisticado por turno; eles: estrutura de output muito mais clara | M | ⭐⭐ |
| **Wire protocol** | JSONL versionado (1.10), TurnBegin/StepBegin/StepRetry/StepInterrupted/CompactionBegin/MCPLoadingBegin etc, RootWireHub pub-sub ([wire/types.py](.reference/kimi-cli/src/kimi_cli/wire/types.py)) | SSE+IPC com `ChatDelta` union; bem tipado mas sem versionamento explícito | Eles têm framing mais explícito (retry/interrupted/loading) e versão | M | ⭐⭐⭐ |
| **Approval runtime** | Async context vars rastreiam "quem pediu" + fila de pending + bridge soul↔UI ([approval_runtime/](.reference/kimi-cli/src/kimi_cli/approval_runtime)) | Confirm-gate inline no runner, sem context tracking; submit_plan/submit_spec como gates | Approval source tracking permite UI cachear approvals por origem | M | ⭐⭐ |
| **Session fork** | Enum turns via wire.jsonl parsing, truncate at turn N, copy state → fork ([session_fork.py](.reference/kimi-cli/src/kimi_cli/session_fork.py)) | Não temos; coder sessions são append-only | Permitir UI: "voltar pro turno X e tentar outra coisa" | M | ⭐⭐⭐ |
| **Hooks** | 2 tipos: shell-side cmds + client-side wire requests; regex matcher; pre/post tool ([hooks/engine.py](.reference/kimi-cli/src/kimi_cli/hooks/engine.py)) | Hook único de system-prompt em `runSystemPromptHook` (vm sandbox) | Eles têm engine genérico extensível | M | ⭐⭐ |
| **Plugin system** | Discovery em `~/.kimi/plugins/`, `plugin.json` ([plugin/](.reference/kimi-cli/src/kimi_cli/plugin)) | MCP server bridge (proxies tools de servidores MCP) | MCP cobre maior parte; plugin system local nativo seria pra extensões não-MCP | L | ⭐ |
| **Skill discovery** | Multi-scope: builtin > user > project > extra-CLI ([skill/__init__.py](.reference/kimi-cli/src/kimi_cli/skill/__init__.py)) | `invoke_skill` tool com discovery mas sem precedence scopes | Útil pra "skill local sobrescreve builtin" | S | ⭐⭐ |
| **AGENTS.md generator** | Slash `/init` → roda agente que explora repo e escreve `AGENTS.md` com seções padrão ([init.md](.reference/kimi-cli/src/kimi_cli/prompts/init.md)) | Não temos — só temos snapshots manuais | Onboarding zero-knowledge pra novos projetos | S | ⭐⭐⭐ |
| **Compact slash** | `/compact` → roda summarization estruturada do contexto | Compactação é automática no token-budget hit; sem comando explícito | UX: usuário forçar compaction quando quiser | XS | ⭐⭐ |
| **Plan mode** | `/plan` (toggle), `PlanModeInjectionProvider` injeta `<plan-mode>` por turno ([dynamic_injections/plan_mode.py](.reference/kimi-cli/src/kimi_cli/soul/dynamic_injections/plan_mode.py)) | Plan mode existe (profile + `submit_plan`) mas injection é via system-prompt, não user-message | Injection turn-by-turn é mais cache-friendly | M | ⭐⭐ |
| **AFK mode** | `/afk` (toggle) com injection provider análoga | Não temos | Útil pra sessões longas autônomas | S | ⭐ |
| **YOLO mode** | `/yolo` toggle: skipa toda approval | `auto-confirm` flag em session, sem toggle de chat | UX: comando explícito > flag de DB | XS | ⭐ |
| **Background tasks** | Subprocess persistido em `.kimi/tasks/`, status+notifications, context restore on resume ([background/](.reference/kimi-cli/src/kimi_cli/background)) | Worker pool existe mas não persiste por projeto; sem retomada | Reativar long builds (npm/git) após restart | L | ⭐⭐ |
| **Notifications** | Pub-sub com `dedupe_key`, sinks múltiplos (llm/email/webhook) | Meta-bus do company emite eventos; sem dedupe_key | Toast de Electron com dedup | M | ⭐ |
| **Indexer/RAG** | Web fetch + search básico via tools | Hybrid search (FTS+vector+RRF+rerank), symbol DB, 100+ migrations | Nós muito superior — não importar | — | — |
| **Multi-agent orchestration** | Subagents via `prepare_soul` ([subagents/core.py](.reference/kimi-cli/src/kimi_cli/subagents/core.py)); 1 nível de hierarquia | Master+subordinates+kanban+pipelines+role-recommendation | Nós muito superior — não importar | — | — |
| **IDE/UI** | Multi-backend: shell TUI, print, web (FastAPI), acp, vis (FastAPI scalar) | Electron + React + Monaco + xterm.js + file tree | Nós muito superior — não importar | — | — |
| **Auth/OAuth** | OAuth via browser + device flow + keyring ([auth/oauth.py](.reference/kimi-cli/src/kimi_cli/auth/oauth.py)) | Scaffolding presente, não terminado | Aproveitar padrão keyring + browser flow | L | ⭐⭐ |
| **ACP** | Servidor ACP nativo (Zed, JetBrains) ([acp/](.reference/kimi-cli/src/kimi_cli/acp)) | Não temos | Acessar usuários de outras IDEs sem nossa Electron | L | ⭐ |
| **VS Code ext** | `moonshot-ai.kimi-code` (oficial) | Não temos | Reach distribution | L | ⭐ |
| **Plugin Zsh** | `zsh-kimi-cli` repo separado | Não temos | Empoderar shell normal | M | ⭐ |
| **Testes** | pytest, `tests/`, `packages/kaos/tests`, `packages/kosong/tests` (snapshot pra chat APIs) | vitest configurado, poucos pacotes com unit tests | Gap nosso conhecido; deles é referência boa | — | — |
| **CI** | GitHub Actions: ci, release (PyPI), docs-pages; Python 3.14 + uv 0.8.5 | Sem CI no monorepo (commits locais via husky?) | Gap nosso; vale copiar shape | M | ⭐⭐ |

---

## 2. Backlog priorizado

### HIGH — destrava valor curto prazo

#### H1. Corrigir H2 do bug KIMI: omitir `content` whitespace-only com tool_calls — ✅ **FEITO**
**Esforço:** S (S). **Onde:** [kimi-code.ts](packages/code-agent/src/providers/kimi-code.ts) — `appendAssistantMessage` e novo helper `isEffectivelyEmptyText`.
**Por quê:** evidência direta em `kosong/kimi.py:318-329` mostra que Kimi-for-Coding retorna `400 "text content is empty"` quando assistant message tem `content: [{type:"text", text:""}]` + tool_calls. Nossa serialização atual omite content só quando `text === ''` literal — não trata `text === ' '`, `'\n'`, etc. Espelhar o helper `_is_effectively_empty_content_parts` deles.
**Status:** corrigido. Adicionado helper `isEffectivelyEmptyText` que espelha o do kosong; `appendAssistantMessage` agora omite `content` quando há tool_calls + texto vazio/whitespace. Bonus do mesmo PR: **H6** (skip empty tool_call deltas, mirrors `kosong/kimi.py:479-481`) — evita ghost tool_uses com name="". Cobertos por [`__tests__/kimi-code.test.ts`](packages/code-agent/src/providers/__tests__/kimi-code.test.ts) (8 cases, todos verdes).

#### H2. Adicionar slash `/init` (gerador de AGENTS.md) — ✅ **FEITO**
**Esforço:** S. **Onde:** [packages/code-agent/src/skills/builtin/init.md](packages/code-agent/src/skills/builtin/init.md) (nova skill) + [packages/indexer/src/bootstrap/ensure-builtin-skills.ts](packages/indexer/src/bootstrap/ensure-builtin-skills.ts) (~10 LOC pra ler `slash-command` do frontmatter).
**Por quê:** onboarding instantâneo pra projetos novos. Resultado vira fonte canônica que o próprio agente lê em sessões futuras. Custo dev mínimo, valor de marketing alto.
**Status:** registrado como skill builtin com `slash-command: init` no frontmatter. Prompt instrui o agente a **detectar o idioma do projeto automaticamente** (regex de PT-BR via cedilha/til/acentos + palavras-chave; fallback EN) e gerar `AGENTS.md` com seções estruturadas (overview/stack/layout/build/run/test/entry points/conventions/security/notes-for-agents). Reusa o slash command intercept que já existia no [Composer.tsx:215-227](apps/dashboard/features/chat/composer/Composer.tsx:215). Limitação MVP: roda dentro de uma sessão **já aberta** — usuário clica "new chat" e digita `/init`. Cobertos por 2 testes adicionais em [`src/__tests__/bootstrap-builtin-skills.test.ts`](src/__tests__/bootstrap-builtin-skills.test.ts).

#### H3. Versionar nosso wire protocol e adicionar tipos `StepRetry/StepInterrupted/MCPLoadingBegin`
**Esforço:** M. **Onde:** [packages/code-agent/src/core/messages.ts](packages/code-agent/src/core/messages.ts), [packages/api-bus](packages/api-bus).
**Por quê:** com 7 providers e Electron+web, ter framing explícito de retry/interrupt/loading ajuda muito a UI mostrar "tentando de novo" em vez de "travou". Versionar (ex: `protocol_version: "2.0"`) permite cliente-servidor desacoplados.
**Como:** adicionar variantes ao `ChatDelta` union; adicionar `protocol_version` ao header SSE/IPC; manter retrocompat por 1 release.

#### H4. Session fork / checkpoint
**Esforço:** M. **Onde:** [packages/store](packages/store) + dashboard.
**Por quê:** kimi-cli permite "voltar pro turno N e tentar outra coisa" via `session_fork.py`. Para um IDE essa é UX MUITO superior à "delete e recomeça". Nossas sessões já são append-only no DB — falta o operador de fork + UI.
**Como:** snapshot tabular do estado da sessão (messages, tool_results) com FK no novo session_id; UI: botão "fork from here" no transcript.

#### H5. Hooks engine (pre/post tool, regex matcher, shell+wire)
**Esforço:** M. **Onde:** [packages/code-agent/src/core/hooks.ts](packages/code-agent/src/core/hooks.ts) (já existe mas único uso é system-prompt).
**Por quê:** kimi-cli expõe hooks tanto de shell (rodar comando local) quanto wire (mandar pra UI). Útil pra auto-formatting, lint check após edit, notificação no Slack, etc. Engine já existe — só falta generalizar.
**Como:** estender hook config no `.mcp-indexer/hooks/`, suportar matcher por tool-name regex, fases `before|after`, retorno que pode bloquear ou anotar.

### MED — melhorias estruturais

#### M1. Agent spec YAML com herança (vs hard-coded TS profiles)
**Esforço:** M. **Onde:** [packages/code-agent/src/agents](packages/code-agent/src/agents).
**Por quê:** kimi-cli define profiles em YAML com `extend:` e permite override por usuário. Nossos `explore/plan/build/admin/spec` são código TS. Migrar pra YAML/JSON declarativo abre customização do usuário e facilita experimentar perfis.
**Como:** spec Zod do AgentSpec; loader que mescla builtin + user `~/.mcp/agents/*.yaml`; runner consome AgentSpec em vez de constants.

#### M2. Dynamic injection per-turn (active-context melhorada)
**Esforço:** S. **Onde:** runner já tem `buildActiveContextBlock`; estruturar como providers ([dynamic_injection.py](.reference/kimi-cli/src/kimi_cli/soul/dynamic_injection.py) referência).
**Por quê:** kimi-cli tem `DynamicInjectionProvider` interface — afk_mode, plan_mode etc injetam blocos no histórico por turno sem mexer no system-prompt (preserva cache). Nosso `<active-context>` já é isso, mas como string ad-hoc. Estruturar permite plugar n providers.
**Como:** definir `DynamicInjectionProvider` interface em TS; converter `<active-context>` no primeiro provider; adicionar `<plan-mode>`, `<afk-mode>`.

#### M3. Multi-scope skill discovery (builtin > user > project)
**Esforço:** S. **Onde:** [packages/code-agent/src/skills](packages/code-agent/src/skills) e `invoke_skill` tool.
**Por quê:** usuário poder override skill builtin com versão local sem fork. Pattern testado.
**Como:** discovery lê 4 paths em ordem; nome colide → precedence; comando `list_skills` mostra qual venceu.

#### M4. `with_extra_body` field-merge para thinking config
**Esforço:** S. **Onde:** [kimi-code.ts:62-65, 199-206](packages/code-agent/src/providers/kimi-code.ts:62).
**Por quê:** kosong faz field-merge do `thinking` config ([kimi.py:227-248](.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:227)) — `with_thinking('high')` + `with_extra_body({thinking:{keep:"all"}})` mantém type=enabled. Nosso código sobrescreve.
**Como:** adicionar `KIMI_MODEL_THINKING_KEEP` env var e merge logic análoga.

#### M5. Approval runtime com context vars (rastrear origem)
**Esforço:** M. **Onde:** [packages/code-agent/src/core/policy.ts](packages/code-agent/src/core/policy.ts).
**Por quê:** quando o usuário aprovou "rodar git_commit", kimi-cli sabe que foi pela tool X; pode cachear: "se a mesma source pedir de novo, não pergunta". Nossa policy não tem essa noção.
**Como:** AsyncLocalStorage no Node pra ApprovalSource; cache "decisões aprovadas neste turno" por source.

#### M6. Builtin functions prefix `$` — ✅ **FEITO**
**Esforço:** S. **Onde:** [kimi-code.ts](packages/code-agent/src/providers/kimi-code.ts) — nova função `toKimiToolParam`.
**Por quê:** Kimi tem builtin functions (ex: `$web_search` server-side). Tool com `name.startsWith('$')` deve ir como `type: 'builtin_function'`. Hoje mandamos como `function` normal — Kimi pode estar reclamando silenciosamente.
**Status:** corrigido. Helper `toKimiToolParam` espelha `kosong/kimi.py:344-356` — quando `name` começa com `$`, emite `{type:'builtin_function', function:{name}}` sem description/parameters; senão fallback pro shape `function` normal. Cobertos por 3 testes adicionais em [`__tests__/kimi-code.test.ts`](packages/code-agent/src/providers/__tests__/kimi-code.test.ts).

### LOW — backlog distante / niche

#### L1. ACP adapter (Zed, JetBrains)
**Esforço:** L. **Por quê:** ganha usuários de outras IDEs. **Quando:** após auth/billing.

#### L2. Plugin Zsh
**Esforço:** M. **Por quê:** integrar agente no shell padrão. **Quando:** se o produto bombar e fizer sentido pra dev workflow Unix.

#### L3. VS Code extension
**Esforço:** L. **Por quê:** marketplace reach. **Quando:** depois de validar workflow no nosso Electron.

---

## 3. O que NÃO devemos copiar

### Kosong SDK (provider abstraction deles)
**Por quê:** nossa `ChatProvider` interface ([adapter.ts](packages/code-agent/src/providers/adapter.ts)) é mais simples e cobre nossos casos. Kosong faz a mesma coisa em Python com mais cerimônia (`with_thinking`, `with_extra_body`, `with_generation_kwargs` retornando self copiado). **Aprender** padrões pontuais (field-merge, builtin functions) sem copiar a arquitetura.

### Multi-UI backend (shell + print + web + acp + vis)
**Por quê:** somos Electron-first. Manter UMA UI rica é melhor que N magras. ACP e VS Code são backlog separado se chegar a hora.

### Telemetry stack
**Por quê:** já temos `coder_turn_telemetry` no SQLite + meta-bus. Aprender o shape dos eventos (`init_complete`, `tool_call`, `crash`) é útil; trocar de stack, não.

### `denwa_renji` / soul `_runtime` (Python idioms)
**Por quê:** padrão de hub central de runtime services não casa com nosso DI por imports + factories. Forçar a estrutura traria refactor grande sem ganho claro.

### Kaos (filesystem + path abstraction package)
**Por quê:** Node tem `fs/promises` + `path` nativos. Não precisamos de KaosPath.

---

## 4. Apêndice: mapa de `src/kimi_cli/` (1 linha por entrada)

| Path | O que é |
|------|---------|
| `acp/` | Servidor Agent Client Protocol (Zed, JetBrains compat); converte config MCP→ACP; multiplexing. |
| `agents/default/`, `agents/okabe/` | Agent specs YAML; default = main, okabe = perfil alternativo. Subagentes coder/explore/plan. |
| `approval_runtime/` | Fila async de approval requests com context vars (`ApprovalSource`) e futures cancelable. |
| `auth/oauth.py` | OAuth browser+device flow, keyring storage, multi-provider. |
| `background/` | Subprocess agents persistidos em `.kimi/tasks/`, status tracking, notifications, resume. |
| `cli/` | Typer-based entry point: `cli`, `acp`, `mcp add/list/remove/auth`, `export`, `import`, `vis`, `web`. |
| `deps/` | (Makefile placeholder — sem código relevante.) |
| `hooks/engine.py` | Hook engine pre/post; 2 caminhos: shell command + wire request; regex matcher; timeout. |
| `mcp_oauth.py` | MCP OAuth token storage via FileTreeStore (`~/.kimi/mcp-oauth/`). |
| `notifications/` | Pub-sub com dedupe_key, múltiplos sinks (llm, email, webhook), stale claim recovery. |
| `plugin/manager.py` | Discovery em `~/.kimi/plugins/`, lê `plugin.json`, registra tools dinamicamente. |
| `prompts/init.md` | Prompt do `/init` — gera `AGENTS.md` zero-knowledge. |
| `prompts/compact.md` | Prompt do `/compact` — output XML-like com 6 seções fixas. |
| `skill/` | Discovery multi-scope, parser para flows (mermaid/d2). |
| `skills/` | (Vazio — placeholder para skills builtin futuras.) |
| `soul/agent.py` | Loader de agent YAML, Jinja2 system prompt rendering. |
| `soul/kimisoul.py` | FSM principal: turn/step loop, hooks, approvals, subagents, compaction. Onde estaria o anti-loop. |
| `soul/slash.py` | Slash command registry (`/init`, `/compact`, `/clear`, `/yolo`, `/afk`, `/plan`, `/add-dir`, `/export`). |
| `soul/toolset.py` | KimiToolset — coleta tools de agent spec + plugins + MCP. |
| `soul/compaction.py` | SimpleCompaction (substituível). Trigger por token budget. |
| `soul/dynamic_injection.py` | Interface `DynamicInjectionProvider` — injeta blocos turn-by-turn. |
| `soul/dynamic_injections/plan_mode.py` | Injeção `<plan-mode>` quando ativo. |
| `soul/dynamic_injections/afk_mode.py` | Injeção `<afk-mode>` (sessão autônoma). |
| `subagents/` | Builder de child agents (prepare_soul, AgentLaunchSpec, LaborMarket). |
| `telemetry/` | Eventos anônimos + crash reports via HTTP sink. |
| `tools/` | shell, file (read/write/grep/glob), web (fetch/search), ask_user, todo, agent (spawn), background, plan, dmail, think, test. |
| `ui/shell/`, `ui/print/`, `ui/acp/` | Adapters de output por UIMode. |
| `vis/app.py` | FastAPI server para visualizar traces de agent runs. |
| `web/app.py` | FastAPI REST API completo (session mgmt, files browser, runner pool). |
| `wire/protocol.py` | Wire protocol version 1.10 — JSONL streaming. |
| `wire/types.py` | TurnBegin/StepBegin/StepInterrupted/StepRetry/CompactionBegin/MCPLoadingBegin/ToolResult/etc. |
| `wire/root_hub.py` | RootWireHub pub-sub para broadcast de wire messages (out-of-order safe). |
| `app.py` | Main entry: load config → create session → run soul. Logging setup. |
| `session.py` | Session = id + work_dir + context.jsonl + wire.jsonl + state.json + subagents/. |
| `session_fork.py` | Enum turns parsing wire.jsonl, truncate at turn N, fork sessão. |
| `session_state.py` | state.json: approval mode, additional_dirs, plan_mode, todos, archived. |
| `agentspec.py` | Pydantic AgentSpec + SubagentSpec; herança via `extend: file.yaml`. |
| `config.py` | TOML parser, env var augmentation, Pydantic models. |

**Packages externos do monorepo deles:**
- `packages/kosong/` — provider abstraction + chat providers (kimi, openai_legacy, openai_responses, anthropic, google_genai, echo, chaos).
- `packages/kaos/` — filesystem/path abstraction (não relevante pra Node).
- `packages/kimi-code/` — funções shared com Kimi-for-Coding (não inspecionado).

**Slash commands expostos:** `/init`, `/compact`, `/clear`, `/yolo`, `/afk`, `/plan`, `/add-dir`, `/export`, `/import`.

**ENV vars Kimi:** `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL_NAME`, `KIMI_MODEL_MAX_CONTEXT_SIZE`, `KIMI_MODEL_CAPABILITIES`, `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P`, `KIMI_MODEL_MAX_TOKENS`, `KIMI_MODEL_THINKING_KEEP`, `KIMI_SCRIPTED_ECHO_SCRIPTS`, `KIMI_SCRIPTED_ECHO_TRACE`.

---

## 5. Onde o doc de auditoria informa o fix do bug (referência cruzada)

Quando abrir o plano da Fase E (fix do KIMI loop), começar por estes pontos confirmados aqui:

1. **H2 confirmada** ([kosong/kimi.py:318-329](.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:318)) → item HIGH H1 deste backlog. **✅ Corrigido.**
2. **Streaming de tool_calls deles é diferente do nosso** ([kosong/kimi.py:463-481](.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:463)): emitem `ToolCall` quando vem `function.name`, `ToolCallPart` quando vem só `arguments`, **skip explicit em empty tool_calls** ("skip empty tool calls"). Nosso `toolAcc` por `tc.index` pode estar processando chunks vazios como reais (criando entradas no Map sem name/args). **✅ Corrigido junto com H1** — guard adicionado em `chat()`: `if (!tc.id && !tc.function?.name && !tc.function?.arguments) continue;`.
3. **`_last_tool_calls`** ([kimisoul.py:190](.reference/kimi-cli/src/kimi_cli/soul/kimisoul.py:190)): kimi-cli tracka tuple `(name, arguments)` das últimas calls — provavelmente pra anti-loop ou retry decision. Vale ler `kimisoul.py` linhas em torno disso quando atacar Fase E.
4. **`KIMI_MODEL_THINKING_KEEP`** + thinking field-merge — se thinking config tá sendo dropado em retries, modelo pode estar mudando comportamento mid-conversation.

Salvar este doc, abrir plano da Fase E depois da Fase C (repro) confirmar/descartar cada hipótese com log real.
