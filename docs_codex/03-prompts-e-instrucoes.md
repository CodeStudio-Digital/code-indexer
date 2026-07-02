# Prompts e Instruções do Codex

## Visão geral

Codex usa prompts compostos por templates Markdown embutidos e fragmentos de contexto gerados em runtime. As instruções cobrem personalidade, estilo de resposta, edição de código, permissões, sandbox, approvals, goals, compaction, realtime, review, AGENTS.md, skills, plugins e colaboração/multi-agent.

A crate `codex-rs/prompts` reexporta constantes e helpers de prompt (`.referece/codex/codex-rs/prompts/src/lib.rs:1-25`). Vários templates são parseados uma vez com `LazyLock<Template>`, falhando se a sintaxe embutida estiver inválida (`.referece/codex/codex-rs/prompts/src/review_request.rs:22-40`, `.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:34-45`, `.referece/codex/codex-rs/prompts/src/goals.rs:5-28`).

## Base instructions

O template base de modelo declara: “You are Codex, a coding agent based on GPT-5” e injeta `{{ personality }}` diretamente no bloco base (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:1-4`).

Regras de formato vivem no mesmo template (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:5-24`):

- colaboração em terminal/plain text;
- Markdown permitido;
- evitar bullets aninhados;
- headers em Title Case somente quando úteis;
- referências de arquivos clicáveis em inline code;
- sem URIs;
- sem emojis.

A seção “Presenting your work” orienta respostas concisas, sumarização de command output, code references e próximos passos numerados apenas quando naturais (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:27-37`).

As regras de edição incluem ASCII por default, comentários raros, preferência por `apply_patch`, cuidado com dirty worktree, proibição de comandos git destrutivos e modo review focado em findings/riscos/testes (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:42-68`). O mesmo template contém regras frontend para UI deliberada e não genérica (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:69-81`).

## Personalidades

Há personalidades separadas:

- pragmatic: clareza, pragmatismo, rigor, concisão, challenge/escalation educado (`.referece/codex/codex-rs/core/templates/personalities/gpt-5.2-codex_pragmatic.md:1-18`);
- friendly: calor, colaboração, suporte, onboarding e escalation gentil (`.referece/codex/codex-rs/core/templates/personalities/gpt-5.2-codex_friendly.md:1-20`).

A personalidade é interpolada no template base como uma variável, não uma camada separada de canal (`.referece/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md:3`). Overrides de personalidade podem ser empacotados como developer fragment com marcadores fixos (`.referece/codex/codex-rs/core/src/context/personality_spec_instructions.rs:14-31`).

## Permissões, sandbox e approvals

`permissions_instructions.rs` carrega templates Markdown para approval policies e sandbox modes (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:17-45`). `PermissionsInstructions::from_permission_profile` monta instruções a partir do permission profile efetivo, approval policy, reviewer, exec policy, cwd e feature flags de exec permission approvals/request-permissions (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:61-89`).

A montagem concatena seções de sandbox, approval, writable roots e denied reads, sempre com newline final (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:111-140`). O fragmento entra no contexto como developer-role `ContextualUserFragment` com marcadores `<permissions instructions>...</permissions instructions>` (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:143-159`).

Mapeamento de filesystem policy para prompt (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:161-183`):

- full disk write → `DangerFullAccess`;
- sem writable roots → `ReadOnly`;
- caso contrário → `WorkspaceWrite`.

Network policy mapeia para enabled/restricted. Approval policy varia por `AskForApproval::{Never, UnlessTrusted, OnRequest, Granular}`, com orientação extra para `request_permissions` e prefixos de comandos aprovados (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:192-244`). Quando `ApprovalsReviewer::AutoReview` está ativo e approvals não são `Never`, há sufixo indicando que escalations serão revisadas (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:237-243`).

Writable roots e denied filesystem reads são explicitamente descritos; denied reads são restrições de policy e o prompt diz para não pedir escalation para eles (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:258-295`). O modo granular emite allow/deny por categoria: sandbox approval, rules, skill approval, request_permissions e MCP elicitations (`.referece/codex/codex-rs/prompts/src/permissions_instructions.rs:303-380`).

Templates fonte:

- approval: `prompts/templates/permissions/approval_policy/{never,unless_trusted,on_request,on_request_rule_request_permission}.md`;
- sandbox: `prompts/templates/permissions/sandbox_mode/{danger_full_access,workspace_write,read_only}.md`.

## Compaction

Compaction/summarization usa templates embutidos: `compact/prompt.md` e `compact/summary_prefix.md` (`.referece/codex/codex-rs/prompts/src/compact.rs:1-2`). Isso indica que o resumo de contexto tem prompt próprio e prefixo padronizado.

## Goals

Prompts ocultos de goals são montados a partir de três templates: `continuation`, `budget_limit` e `objective_updated` (`.referece/codex/codex-rs/prompts/src/goals.rs:5-28`).

- continuation inclui objective, tokens used, token budget e remaining tokens, com XML escaping do objective (`.referece/codex/codex-rs/prompts/src/goals.rs:30-53`);
- budget limit inclui objective, tokens used, time used e token budget (`.referece/codex/codex-rs/prompts/src/goals.rs:55-75`);
- objective updated reaproveita campos de token/objective (`.referece/codex/codex-rs/prompts/src/goals.rs:77-99`).

## Realtime

Realtime carrega `backend_prompt.md`, `realtime_end.md` e `realtime_start.md` (`.referece/codex/codex-rs/prompts/src/realtime.rs:1-3`). A escolha de backend prompt prioriza override em config, depois request prompt, e por fim default `BACKEND_PROMPT`, substituindo `{{ user_first_name }}` (`.referece/codex/codex-rs/core/src/realtime_prompt.rs:5-24`). O primeiro nome vem de `whoami::realname()` ou `whoami::username()`, fallback `there` (`.referece/codex/codex-rs/core/src/realtime_prompt.rs:26-31`).

Start/end instructions entram como developer fragments embrulhados por tags de realtime conversation; o end inclui motivo (`.referece/codex/codex-rs/core/src/context/realtime_start_instructions.rs:9-27`, `.referece/codex/codex-rs/core/src/context/realtime_end_instructions.rs:19-37`).

## Review prompts

Review request usa templates para uncommitted changes, base branch e commit review (`.referece/codex/codex-rs/prompts/src/review_request.rs:8-40`). `resolve_review_request` retorna target, prompt renderizado e hint user-facing (`.referece/codex/codex-rs/prompts/src/review_request.rs:42-57`).

A seleção é específica (`.referece/codex/codex-rs/prompts/src/review_request.rs:59-98`):

- uncommitted changes usam instrução fixa;
- base-branch tenta merge-base e faz fallback;
- commit reviews podem incluir título;
- instruções custom são trimadas e rejeitadas se vazias.

Mensagens de saída de review vêm de XML templates; sucesso renderiza `results`, interrompido é normalizado (`.referece/codex/codex-rs/prompts/src/review_exit.rs:5-24`). Histórico de review completo embrulha findings em `<user_action>` (`.referece/codex/codex-rs/core/templates/review/history_message_completed.md:1-6`).

## AGENTS.md

O repo tem um `AGENTS.md` raiz com convenções Rust, caveats de sandbox/env vars, formatação/lint/testes e instruções gerais (`.referece/codex/AGENTS.md:1-70`). Há também `AGENTS.md` mais específico no subtree do bottom pane (`.referece/codex/codex-rs/tui/src/bottom_pane/AGENTS.md`).

Conteúdo de AGENTS entra como user-role fragment com header `# AGENTS.md instructions`, corpo em `<INSTRUCTIONS>...</INSTRUCTIONS>` e fechamento `</INSTRUCTIONS>` (`.referece/codex/codex-rs/core/src/context/user_instructions.rs:9-29`).

## Orquestração e multi-agent

O template de orchestrator inclui estilo de plano/update, notas heads-down e orientação de coding style (`.referece/codex/codex-rs/core/templates/agents/orchestrator.md:1-18`). Também contém guidance de review e multi-agent workflow, recomendando subagentes para trabalho paralelizável (`.referece/codex/codex-rs/core/templates/agents/orchestrator.md:19-43`).

O prompt de colaboração experimental descreve quando spawnar agentes: review, trabalho paralelo e execução de testes (`.referece/codex/codex-rs/core/templates/collab/experimental_prompt.md:1-16`). Multi-agent mode pode desabilitar delegação, exigir pedido explícito do usuário ou permitir delegação proativa; suas instruções sobrescrevem modo anterior (`.referece/codex/codex-rs/core/src/context/multi_agent_mode_instructions.rs:6-40`).

## Skills e plugins no prompt

Skills disponíveis são renderizadas a partir de `AvailableSkills`, com seção “How to use skills” variando conforme skill roots (`.referece/codex/codex-rs/core/src/context/available_skills_instructions.rs:10-44`). Entram como developer fragment entre tags de skills (`.referece/codex/codex-rs/core/src/context/available_skills_instructions.rs:47-63`).

Plugins disponíveis só geram fragmento quando existem; a instrução explica nomes de plugins, proveniência MCP, trigger rules e fallback (`.referece/codex/codex-rs/core/src/context/available_plugins_instructions.rs:7-58`). Plugins recomendados mas não instalados entram como user fragment em `<recommended_plugins>` e são truncados a 50 (`.referece/codex/codex-rs/core/src/context/recommended_plugins_instructions.rs:4-48`). Instruções genéricas de plugin são developer fragments sem marcadores (`.referece/codex/codex-rs/core/src/context/plugin_instructions.rs:14-29`).

## Pontos notáveis

- Prompting é modular e muito ligado ao estado runtime.
- Permissões/sandbox não são só enforcement; também aparecem explicitamente no contexto do modelo.
- AGENTS.md é tratado como instrução do usuário, não developer.
- Skills/plugins entram condicionalmente e são parte do prompt context.
- Goals e compaction possuem prompt templates próprios, indicando suporte de longa duração.
