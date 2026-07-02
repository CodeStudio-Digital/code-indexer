# Agent Runtime e Tools

## Visão geral

O runtime de agente vive principalmente em `packages/code-agent`. Ele combina:

- `CoderRunner` como loop/orquestrador de sessão;
- system prompt estático + sufixo dinâmico;
- tool registry com metadados de risco/mutação/escopo;
- plan/spec/build modes;
- tools nativas de FS/shell/diagnostics/review/memory/goal;
- ponte MCP (`mcp__*`);
- subagentes e execução de tasks em ondas;
- permission gate e path scopes;
- compaction e injeção de estado.

## Contrato de tool

`CoderTool` é o contrato compartilhado de ferramenta. Ele define `name`, `description`, schema, source e metadados de execução como `mutates`, `parallelSafe`, `riskLevel`, `riskOf`, `requiresSandbox`, `scopeAware`, `interactive`, `repeatable` e `timeoutMs` (`packages/code-agent/src/core/tool.ts:21-109`).

`ToolContext` injeta o estado runtime que a tool precisa: sessão, runner, overlay, permission gate, permissões e lifecycle hooks. Ou seja, uma tool não é apenas schema para o modelo; ela é executada dentro de um contexto de sessão com hooks e políticas (`packages/code-agent/src/core/tool.ts:149-176`).

## CoderRunner e estado de sessão

`CoderRunner` mantém o estado principal: histórico de mensagens, contador de turnos, slots de input pendentes, abort controllers de tool calls em voo, flags de approval de plan/spec/tasks, task scope inline, ledgers recentes de read/write e histórico de watchdog (`packages/code-agent/src/core/runner.ts:420-538`).

Arquivos editados recentemente são derivados de `recentWrites` e limitados aos 8 paths mais recentes para injeção dinâmica (`packages/code-agent/src/core/runner.ts:523-528`). O runner também suporta múltiplos `waitForUserInput()` concorrentes via `askId`, evitando que prompts independentes sobrescrevam uns aos outros (`packages/code-agent/src/core/runner.ts:430-449`). Tool calls não interativas em voo são rastreadas por tool-use ID para permitir interrupção de uma chamada travada sem abortar toda a run (`packages/code-agent/src/core/runner.ts:452-459`).

## Prompt assembly e modo de execução

O system prompt é montado como prefixo estável/cacheável + sufixo dinâmico separado por `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. O sufixo injeta plan mode, identidade, guidance de tools/tasks, linguagem/estilo, framing autônomo, repo map, comandos de verificação e hooks do projeto (`packages/code-agent/src/core/system-prompt.ts:315-471`).

Plan mode é omitido para agentes `spec`, enquanto a seção de tools interativas diferencia `submit_plan`, `submit_spec`, `task_list`, `execute_tasks`, `task_complete` e lifecycle de task lists (`packages/code-agent/src/core/system-prompt.ts:349-382`). O prompt também contém o loop do agente: persistir até implementação/verificação, mas parar em pedidos puramente analíticos; preâmbulos antes de tool calls são exigidos; releitura repetida de conteúdo já visto é desencorajada (`packages/code-agent/src/core/system-prompt.ts:504-525`).

Hooks locais podem anexar instruções a partir de `.mcp-indexer/hooks/system-prompt.js`; falhas são ignoradas e o prompt permanece inalterado (`packages/code-agent/src/core/system-prompt.ts:436-447`).

A montagem final do prompt é pequena; o comportamento real está no conteúdo versionado e nos módulos de assembly (`packages/code-agent/src/core/runner/assembly/system-prompt.ts:25-110`).

## Plan/spec/build e approvals

Plan approval pode transicionar a run de `plan` para `build`, desbloqueando tools mutantes em memória e persistindo a troca de agente quando há callback (`packages/code-agent/src/tools/plan.ts:33-66`).

`submit_plan` é interativo: registra o plano, aguarda input do usuário, trata interrupção/abort/approval/rejection e limpa/rearma hashes de rejeição conforme o resultado (`packages/code-agent/src/tools/plan.ts:68-197`). Planos rejeitados são hashados para impedir reenvios cosméticos (`packages/code-agent/src/tools/plan.ts:105-196`). A tool também integra o `decision_gate`: forks não perguntados podem disparar um nudge único antes da pausa de aprovação (`packages/code-agent/src/tools/plan.ts:124-140`).

A permission gate classifica risco de tools, auto-permite no modo unrestricted, auto-permite writes em modo auto e, nos demais casos, bloqueia aguardando approval por tool-use ID. O payload de aprovação pode conceder permissão persistente por nome de tool (`packages/code-agent/src/core/permission-gate.ts:167-225`). Approvals resolvidos emitem `tool_approval_resolved` e há keep-alive enquanto approvals ficam pendentes (`packages/code-agent/src/core/permission-gate.ts:227-253`).

## Tool assembly por turno

A montagem de tools por turno aplica listas disabled globais/de sessão, tier filtering, pinned tools, hooks de tool filter e truncamento por `max-tools` (`packages/code-agent/src/core/runner/assembly/tools.ts:69-182`). `NEVER_TRIM` e tools essenciais de company mode são protegidas de truncamento; tool-cap trimming é priority-based, salvo flag legacy (`packages/code-agent/src/core/runner/assembly/tools.ts:125-176`).

Em bootstrap-only e compact-model mode, descrições são encurtadas; tools centrais em `NEVER_TRIM` mantêm texto completo (`packages/code-agent/src/core/runner/assembly/tools.ts:184-200`). `create_goal` fica disponível durante toda a run por estabilidade de cache; o estado de goal é excluído da chave de cache, então o handler precisa rejeitar usos inválidos (`packages/code-agent/src/core/runner/assembly/tools.ts:215-226`).

## Ponte MCP (`mcp__*`)

A ponte MCP injeta defaults como `max_tokens` para tools verbosas e injeta `project_name` quando o schema interno exige (`packages/code-agent/src/tools/mcp-bridge.ts:15-24`, `packages/code-agent/src/tools/mcp-bridge.ts:119-123`). Ela remove `project_name` do schema público mostrado ao modelo, preservando a injeção interna (`packages/code-agent/src/tools/mcp-bridge.ts:73-116`).

Tools MCP são listadas, filtradas por disabled tools, ordenadas por nome e expostas com prefixo `mcp__*`; chamadas podem ser short-circuited pelo overlay antes de ir ao MCP server real (`packages/code-agent/src/tools/mcp-bridge.ts:163-255`). `read_file` vindo do MCP é limitado por hard max, com nota sintética de truncamento quando o clamp é aplicado (`packages/code-agent/src/tools/mcp-bridge.ts:212-231`).

## Goals

As tools de goal são `create_goal`, `get_goal` e `update_goal`; elas persistem estado se callbacks de sessão existem, ou caem para um `WeakMap` por runner (`packages/code-agent/src/tools/goal.ts:116-120`, `packages/code-agent/src/tools/goal.ts:130-284`).

`create_goal` tem burst guard contra rewording repetido na mesma janela de runner (`packages/code-agent/src/tools/goal.ts:159-176`) e recusa criar segundo goal enquanto já há um `in_progress`; pivot exige concluir o atual via `update_goal(status="complete")` (`packages/code-agent/src/tools/goal.ts:185-193`). `get_goal` emite aviso forte para não fazer polling depois que o goal está completo (`packages/code-agent/src/tools/goal.ts:236-243`).

## Checklist/todos e task execution

`todo_write` substitui uma checklist não-pausante; preserva IDs estáveis, avisa sobre múltiplos `in_progress` e rate-limita writes idênticos sem progresso intermediário (`packages/code-agent/src/tools/todo.ts:163-264`). `update_todo` aplica patches atômicos, rejeita shapes mistos, limita a 10 patches e permite completar o item atual e iniciar o próximo em uma chamada (`packages/code-agent/src/tools/todo.ts:309-445`).

`execute_tasks` é o orquestrador determinístico em ondas que substitui um loop singular controlado pelo modelo (`packages/code-agent/src/tools/execute-tasks.ts:1-16`). Tasks são agrupadas por dependências e depois por `parallel_group` dentro da onda (`packages/code-agent/src/tools/execute-tasks.ts:84-124`). O `kind` da task determina artefatos de subagente, allowlist e path scope para implementações (`packages/code-agent/src/tools/execute-tasks.ts:136-143`).

`execute_tasks` lida com plan/spec mode: task lists aprovadas desbloqueiam build mode; chamadas sem aprovação pausam para o usuário (`packages/code-agent/src/tools/execute-tasks.ts:189-243`). A tool recusa execução quando a lista ativa é apenas tracking ou ainda não aprovada (`packages/code-agent/src/tools/execute-tasks.ts:267-276`).

## Subagentes

O prompt de subagente explore é explicitamente read-only, exige resumos periódicos, não permite especulação nem spawn de subagentes (`packages/code-agent/src/tools/subagent.ts:15-31`). O prompt de implementação permite edits, exige verificação, resumo final com arquivos alterados e proíbe prompts interativos porque o parent já decidiu o trabalho (`packages/code-agent/src/tools/subagent.ts:50-75`).

`spawn_agent` consolida variantes anteriores em uma única tool com modos ephemeral/persistent e tipos `explore`, `implement`, `verify`, `review` e `full` (`packages/code-agent/src/tools/spawn-agent.ts:1-40`). Cada tipo tem budgets próprios de tool calls, timeout e stall; `explore` tem chamadas ilimitadas por padrão, mas ainda é limitado por tempo/stall (`packages/code-agent/src/tools/spawn-agent.ts:109-140`).

Subagentes em virtual union workspace recebem briefing sintético `<workspace-context>` com instruções sobre paths relativos ao root virtual e para não inventar project names em chamadas MCP (`packages/code-agent/src/tools/spawn-agent.ts:146-166`). Investigações concluídas podem ser salvas em session memory; embeddings são best-effort background, e sessões company pulam captura por terem shared drive (`packages/code-agent/src/tools/spawn-agent.ts:236-283`).

`runSubagent` é o runner isolado usado por spawn e execute-task flows (`packages/code-agent/src/tools/implement-subagent.ts:1-19`). Specs incluem prompt, allowlist, mensagens iniciais, limites de turnos, abort signal, path scope e modo de enforcement (`packages/code-agent/src/tools/implement-subagent.ts:44-59`). Subagentes não recebem `ctx.runner`; tools interativas como `submit_plan`, `ask_user` e `submit_tasks` ficam indisponíveis (`packages/code-agent/src/tools/implement-subagent.ts:190-199`).

Resultados de subagentes podem carregar sandbox violations, memos/snapshots/board posts coletados e transcript preservado para resume (`packages/code-agent/src/tools/implement-subagent.ts:146-163`). Eles herdam permission gate e approval anchor do parent, então approvals são resolvidos no nível da sessão (`packages/code-agent/src/tools/implement-subagent.ts:312-319`).

## Native FS, path scope e shell

Tools nativas de filesystem resolvem roots por projeto e rejeitam project names incompatíveis, prevenindo acesso acidental entre projetos (`packages/code-agent/src/tools/fs.ts:56-85`). `write_file` e `create_file` são mutantes, scope-aware e marcam overlays/telemetria de arquivos recentes (`packages/code-agent/src/tools/fs.ts:98-172`).

`manage_path` valida paths relativos ao projeto, rejeita traversal, bloqueia operação na raiz e protege `.git`, `.mcp-indexer` e `node_modules` (`packages/code-agent/src/tools/manage-path.ts:28-47`). Suporta `mkdir`, `move` e `delete`, com confirmações explícitas para destrutivos (`packages/code-agent/src/tools/manage-path.ts:155-190`). A resolução segura de paths é centralizada em `resolveSafe`, que rejeita escapes antes da política da tool (`packages/code-agent/src/tools/paths.ts:31-42`).

`run_command` tem gate read-only explícito em plan mode: permite comandos exploratórios seguros, mas bloqueia composição/metacaracteres potencialmente mutantes (`packages/code-agent/src/tools/shell.ts:29-46`). A allowlist é baseada no comando principal, restringe subcomandos git e rejeita formas mutantes como `sed -i`, `git branch`, `git tag` e `git config` (`packages/code-agent/src/tools/shell.ts:47-112`).

A metadata de `run_command` marca a tool como `mutates: false`, embora a própria execução possa mutar; a segurança vem do gate interno em plan mode e do contexto (`packages/code-agent/src/tools/shell.ts:123-235`).

### Gotcha: path scope não é sandbox

Subagent allowlists podem ser sets estáticos, predicados ou `null` para full access; path scope pode apenas avisar ou enforced para writes (`packages/code-agent/src/tools/implement-subagent.ts:39-60`). O próprio comentário diz que `pathScopeMode='enforce-writes'` é mais estrito apenas para write tools; shell permanece warning-only, não sandbox completo (`packages/code-agent/src/tools/implement-subagent.ts:53-60`).

Esse ponto também existe como memória durável do projeto: implement subagents podem escrever fora do escopo via shell, porque `run_command` é allowlisted e não é hard-blocked pelo enforcement de writes.

## Diagnostics e self-review

`get_diagnostics` é wrapper de checker nativo, “Phase 1”, cacheado por mtime (`packages/code-agent/src/tools/diagnostics.ts:7-24`). Dispatch por extensão: TS/JS via `tsc --noEmit`, Python via `ruff` ou `py_compile`, Go via `go vet`, Rust via `cargo check` (`packages/code-agent/src/tools/diagnostics.ts:47-104`). Paths que escapam root são rejeitados, e cache retorna marcador `[cached by mtime]` (`packages/code-agent/src/tools/diagnostics.ts:129-155`).

`self_review` é uma revisão barata das snapshots da própria sessão, distinta de `request_review` (`packages/code-agent/src/tools/self-review.ts:1-15`). Ela é nativa, risco read, repeatable, sempre registrada; falhas de configuração da pipeline viram mensagens de disponibilidade acionáveis (`packages/code-agent/src/tools/self-review.ts:50-115`).

## Memória e injeção de estado

Memória durável de agente é separada de snapshots e scratchpad de sessão (`packages/code-agent/src/tools/project-memory-tools.ts:1-13`). `remember` salva memórias de projeto/usuário e mapeia tipos de memória para categorias do host (`packages/code-agent/src/tools/project-memory-tools.ts:45-106`). `recall_memory` suporta `search` e `list`, é repeatable e retorna conteúdo com notas de possível stale (`packages/code-agent/src/tools/project-memory-tools.ts:108-184`). `forget_memory` arquiva por título/nome em vez de hard-delete (`packages/code-agent/src/tools/project-memory-tools.ts:187-220`).

A política de injeção inclui budgets separados para goal, todo, notes, files, memory index e user memory (`packages/code-agent/src/core/runner/assembly/injection-policy.ts:21-33`). O modo de injeção muda por context window efetiva: minimal, short ou standard; short/minimal injetam todo turno, standard não (`packages/code-agent/src/core/runner/assembly/injection-policy.ts:52-103`).

## Compaction e leitura repetida

Compaction é determinística e apenas reescreve conteúdo antigo de `tool_result`; mensagens de user/assistant são preservadas e o transcript persistente não é mutado (`packages/code-agent/src/core/compaction.ts:1-24`). Suporta cutoff por caracteres e tokens, preserva pares de roles e é idempotente para blocos já compactados (`packages/code-agent/src/core/compaction.ts:114-176`).

O runner aplica enforcement de pre-read para bridge/read tools: bloqueia ou reduz leituras duplicadas sem `force_reread`, mas permite após mutações, quando reads anteriores foram elididos ou quando auto-downgrade está ativo (`packages/code-agent/src/core/runner.ts:2200-2277`).

## Principais riscos operacionais

- `run_command` é metadata non-mutating, mas pode mutar fora de plan-mode se permitido.
- Path scope de subagente não é sandbox real para shell.
- `create_goal` fica sempre na surface por estabilidade e depende do handler para recusar redundância.
- Memória durável é staleness-prone e deve ser verificada contra o código atual.
- Tool-cap trimming precisa proteger tools essenciais; há `NEVER_TRIM` e exceptions de company mode.
