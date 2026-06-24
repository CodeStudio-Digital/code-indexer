# Claude Code — Ferramentas (Tools)

> Documentação extraída via engenharia reversa do binário `claude.exe`
> (Claude Code v2.1.181, Bun standalone).
> Descrições obtidas das tabelas de strings ASCII + UTF-16LE embutidas.
>
> Complemento detalhado: `docs/tool-logic.md` contém a lógica interna recuperável,
> mensagens de erro, guardrails e nível de confiança por tool.

---

## Visão Geral

As tools são o mecanismo pelo qual o agente age no mundo: sistema de arquivos,
shell, web, subagentes, MCP, tarefas, team, cron e workflows internos.

A primeira versão deste documento usava a estimativa **~35 tools**. A revalidação
mais minuciosa encontrou **40+ nomes/aliases/tool-like APIs** no binário, mas nem
todos são sempre expostos ao modelo: alguns são internos, feature-gated, específicos
de team/cron/workflow, ou dependem do modo de execução.

Convenção de nomes:
- Tools nativas: nome direto (`Read`, `Bash`, `Grep`, etc.).
- Tools MCP: prefixo `mcp__<server>__<tool>` para servidores externos.
- Aliases internos existem, mas nem todos foram mapeados exaustivamente; quando a
  correspondência não foi confirmada, este documento marca como baixa/média confiança.

---

## 1. File System (Sistema de Arquivos)

### Read
> **Read a file from the local filesystem.**

Lê arquivos locais. A lógica recuperada mostra:

- `file_path` deve ser caminho absoluto no Claude Code original.
- Retorna conteúdo em formato tipo `cat -n`, com linhas numeradas desde 1.
- Lê imagens (`PNG`, `JPG`, etc.) e apresenta o conteúdo visualmente ao LLM.
- Lê PDFs quando suportado; PDFs grandes (>10 páginas) exigem `pages`, com máximo
  observado de 20 páginas por request.
- Lê notebooks Jupyter (`.ipynb`) com células, outputs e visualizações.
- Não lê diretórios; para listar diretórios o prompt orienta usar tool/shell apropriado.
- Se o usuário fornece path de screenshot, o prompt instrui usar `Read` para visualizá-lo.
- Arquivo existente mas vazio gera system reminder em vez de conteúdo normal.

Regra de cache/anti-releitura:
> *Do NOT re-read a file you just edited to verify — Edit/Write would have errored
> if the change failed, and the harness tracks file state for you.*

Mensagens recuperadas:
- *File unchanged since last read. The content from the earlier Read tool_result in
  this conversation is still current — refer to that instead of re-reading.*
- *Wasted call — file unchanged since your last Read. Refer to that earlier
  tool_result instead.*

### Write
> **Writes a file to the local filesystem, overwriting if one exists.**

Cria arquivo novo ou substitui arquivo inteiro.

Guardrails recuperados:
- Se o arquivo já existe, deve ser lido antes com `Read`; caso contrário a tool falha.
- Preferir `Edit` para modificações parciais em arquivo existente.
- *NEVER create documentation files (*.md) or README files unless explicitly requested
  by the User.*
- *Only use emojis if the user explicitly requests it. Avoid writing emojis to files
  unless asked.*
- *Glob patterns are not allowed in write operations. Please specify an exact file path.*

### Edit
> **Performs a find-and-replace edit on a file.**

Edição direcionada em arquivo existente. Faz parte do mesmo modelo **read-before-write**
de `Write`.

Mensagens de estado recuperadas:
- *File has not been read yet. Read it first before writing to it.*
- *File content has changed since it was last read. This commonly happens when a
  linter or formatter run via Bash rewrites the file. Call Read on this file to
  refresh, then retry the edit.*

### MultiEdit
> Nome observado, mas descrição completa não foi recuperada nesta rodada.

Provável variante de múltiplas edições em lote/encadeadas, mas a semântica exata deve
ser tratada como **inferida** até recuperação de schema/prompt completo.

### Glob
> **Fast file pattern matching. Supports glob patterns like `**/*.js` or
> `src/**/*.ts`. Returns matching file paths sorted by modification time.**

Lógica recuperada:
- Busca arquivos por padrão de nome.
- Funciona em codebases grandes.
- Retorna paths ordenados por `mtime`.
- Usar quando precisa achar arquivos por nome/padrão.
- Para buscas abertas que exigem várias rodadas de globbing/grepping, o prompt
  recomenda usar `Task`/`Agent`.
- Sandbox pode rejeitar padrões amplos demais: *[Sandbox] Glob pattern too broad, skipping:*

### NotebookRead
> Suporte observado via `Read` para `.ipynb`.

Retorna células, outputs, texto e visualizações. Pode aparecer como capacidade/tool
separada dependendo do modo, mas a evidência mais forte está no prompt de `Read`.

### NotebookEdit
> Edita notebooks Jupyter (`.ipynb`).

Aparece junto de `Edit` e `Write` nas métricas de decisões de permissão para edição.
A lógica detalhada de schema/cell não foi recuperada completamente.

---

## 2. Shell / Execução

### Bash
> **Executes a bash command and returns its output.**

Roda comandos shell. O binário contém tabelas de permissão/segurança para comandos
shell e git, mas a matriz completa não foi reconstruída com segurança a partir dos
trechos legíveis.

Guardrails relacionados:
- Para busca de conteúdo, usar `Grep` em vez de `grep`/`rg` via `Bash`.
- Há telemetria/OTEL opcional de detalhes de tool (`OTEL_LOG_TOOL_DETAILS`).

### PowerShell
> Tool distinta observada como `PowerShell`.

A ativação depende de plataforma, env var e feature flag:
- `CLAUDE_CODE_USE_POWERSHELL_TOOL`
- disponibilidade do PowerShell
- feature flag `tengu_cobalt_ridge`

Correção da interpretação anterior: no Windows não é apenas “Bash adaptado”; há lógica
runtime que seleciona entre `Bash` e `PowerShell` quando a tool PowerShell está habilitada.

### BashOutput
> Lê a saída de um comando shell/background.

Mensagem observada:
- *Read the output file to retrieve the result:*

### KillShell / KillBash
> Termina processos shell em execução.

Mensagem observada:
- *killShellTasksForAgent: killing orphaned shell task*

### Cd
> Muda o diretório de trabalho corrente.

Nome real observado (`Cd`), mas validações/path handling não foram recuperados de
forma completa.

### REPL
> Ambiente REPL interativo.

Feature-gated por variáveis/flags como `CLAUDE_REPL_VARIANT`, `CLAUDE_CODE_REPL`,
`CLAUDE_CODE_ENTRYPOINT` e `tengu_slate_harbor`. Quando habilitado, a extração mostra
um conjunto permitido contendo `Read`, `Glob`, `Grep`, `Bash`, `PowerShell` e
`NotebookEdit`.

---

## 3. Busca e Web

### Grep
> **Content search built on ripgrep. Prefer this over `grep`/`rg` via `Bash`.**

Lógica recuperada:
- Usa `ripgrep`, não grep clássico.
- Regex completo (`log.*Error`, `function\s+\w+`, etc.).
- Filtros: `glob` e `type`.
- `output_mode`:
  - `content` — linhas correspondentes;
  - `files_with_matches` — apenas paths (default observado);
  - `count` — contagens.
- Braces literais precisam de escape, ex.: `interface\{\}`.
- Matching multiline exige `multiline: true`.
- Para buscas abertas/multirrodadas, o prompt recomenda `Task`/`Agent`.

### WebSearch
> **Search the web. Returns result blocks with titles and URLs.**

Lógica recuperada:
- Suporta filtros de domínio include/block.
- String observada: WebSearch é **US-only**.
- Guardrail temporal: para informações recentes, usar o ano atual na query.

### WebFetch
> **Fetches a URL, converts the page to markdown, and answers `prompt` against it
> using a small fast model.**

Lógica recuperada:
- Falha para URLs autenticadas/privadas; usar MCP autenticado ou `gh` quando aplicável.
- HTTP é atualizado para HTTPS.
- Redirect cross-host é retornado ao agente em vez de seguido automaticamente.
- Respostas cacheadas por 15 minutos por URL.
- Exceção observada: `claude.ai/code/artifact/{uuid}` pode ser fetchado via login claude.ai.
- Setting relacionado: `skipWebFetchPreflight`.

---

## 4. Agente / Task / Skill / Plano

### Task
> **Launch a new agent to handle complex, multi-step tasks. Each agent type has
> specific capabilities and tools available to it.**

Spawna subagentes. Tipos observados nesta build: `fork`, `explore`, `implement`,
`full`, `persistent`.

Ressalva: a lista é **observada**, não garantida como enumeração fechada para todas
as versões.

Regras recuperadas/validadas:
- Usar 1 agent para tarefa isolada em arquivos conhecidos.
- Usar múltiplos agents para tópicos independentes em paralelo.
- Não usar `implement` para trabalho read-only; `explore` é mais barato.

### TodoWrite
> **Create and update a task list for the current session.**

Usada para rastrear progresso e pendências. O sistema injeta reminders quando a lista
não é atualizada por muito tempo em tarefas que se beneficiariam de tracking.

Campos observados:
- `content` — forma imperativa;
- `activeForm` — forma presente contínua;
- `status` — estado;
- `id`/alias normalizado.

### Skill
> **Invoke a skill.**

Guardrails:
- Só invocar skill listada ou digitada explicitamente pelo usuário como `/<name>`.
- Nunca inventar skill name de training data.
- Quando uma skill casa com a solicitação, a invocação é blocking requirement antes
  de qualquer outra resposta.
- Não invocar skill já em execução.

### EnterPlanMode
> **Use this tool proactively when you're about to start a non-trivial implementation task.**

Transiciona para plan mode. Mensagens/eventos observados:
- *EnterPlanMode tool cannot be used in agent contexts*
- *Entered plan mode. You should now focus on exploring the codebase and designing
  an implementation approach.*
- *User declined to enter plan mode*
- *Exited plan mode*

### ExitPlanMode
> Nome interno observado: `ExitPlanMode`.

Existe como nome/tool de transição. A extração confirma estados de saída/retorno do
plan mode, mas o prompt/schema completo não foi recuperado com a mesma clareza de
`EnterPlanMode`.

### AskUserQuestion
> **Asks the user multiple choice questions to gather information, clarify ambiguity,
> understand preferences, make decisions or offer them choices.**

Guardrails:
- Usar só quando a resposta do usuário muda o próximo passo.
- Não usar para fatos verificáveis ou escolhas com default convencional.
- Usuário sempre pode escolher `Other`.
- `multiSelect: true` permite múltiplas respostas.
- Se recomendar uma opção, ela deve ser a primeira e terminar com `(Recommended)`.
- Para “Is this plan okay?”, usar `EnterPlanMode`, não `AskUserQuestion`.
- `preview` existe para comparar artefatos em single-select.

### StructuredOutput
> Retorna dados estruturados conforme JSON Schema.

Lógica recuperada:
- Usa AJV para validar schema.
- Se falha: *Output does not match required schema* / *StructuredOutput schema mismatch*.
- Se passa: retorna `structured_output` e `data: "Structured output provided successfully"`.
- `maxResultSizeChars` observado: `1e5`.
- Usado por workflow/subagents que precisam responder via tool call estruturado.

---

## 5. Task List (Sistema de Tarefas)

### TaskCreate
> **Create a new task in the task list.**

Cria item na task list da sessão. Observação importante:
> *TaskCreate adds an item to the task list and takes `subject` and `description`
> string parameters. To delegate work to a subagent, use the [Task] tool instead.*

### TaskGet
> **Get a task by ID from the task list.**

### TaskUpdate
> **Update a task in the task list.**

### TaskOutput
> Lê output de task/subagente assíncrono.

Mensagem observada:
- *TaskOutput failed*

---

## 6. MCP (Model Context Protocol)

### ListMcpResources
> **List MCP resources from server.**

Exemplos observados:
- `listMcpResources`
- `listMcpResources({ server: "myserver" })`

### ReadMcpResource
> **Read a resource from a server.**

Exemplo observado:
- `readMcpResource({ server: "myserver", uri: "my-resource-uri" })`

### WaitForMcpServers
> Aguarda servidores MCP ficarem disponíveis.

Transports suportados observados:
- `StdioClientTransport`
- `SSEClientTransport`
- `StreamableHTTPClientTransport`

---

## 7. Time / Multi-Agente / Peers

### SendMessage
> Envia mensagem para membros do time, workers ou peers, dependendo do contexto.

Prompt de team:
> *To communicate with anyone on your team, use the SendMessage tool with `to: "<name>"`.*

Também usado pelo coordinator para continuar worker existente ou falar com peer
cross-session. Resposta textual comum não é visível aos teammates.

### SendUserMessage
> Envia mensagem para o usuário final em fluxos multi-agente/non-interactive.

### ListAgents
> Lista agentes/sessões disponíveis.

### ListPeers
> Baixa confiança nesta rodada.

`ListPeers` aparece como conceito/possível alias em documentação anterior, mas a
extração desta rodada não confirmou um `var` direto equivalente. Tratar como menos
validado que `ListAgents`.

### AgentOutput / AgentOutputTool
> Expõe/outputa resultado de agente.

Lógica detalhada não recuperada.

---

## 8. GitHub / CI / Worktree

### ConnectGitHub
> Conecta/autentica com GitHub.

Telemetria observada: `tengu_git_operation` com operations `commit`, `commit_amend`,
`push`, `pr_create`, `pr_edit`, `pr_merge`, `pr_comment`, `pr_close`, `pr_ready`.

### ExitWorktree
> Sai de uma sessão em git worktree.

Mensagens observadas:
- *ExitWorktree: original directory...*
- *Already in a worktree session. Pass `path` to switch into another existing
  worktree, or use ExitWorktree to leave this one before creating a new worktree.*

---

## 9. Agendamento (Cron)

### CronCreate
> Agenda prompt para rodar no futuro.

Pode ser recorrente via cron ou one-shot. Em modo durable, persiste em
`.claude/scheduled_tasks.json`; caso contrário é session-only.

Feature flags observadas:
- `tengu_kairos_cron`
- `tengu_kairos_cron_durable`

### CronDelete
> Remove tarefa agendada.

### CronList
> Lista tarefas agendadas.

String observada:
> *Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will wake this
> session later. Empty array when none are scheduled.*

### ScheduleWakeup
> Agenda wakeup da sessão.

Aparece junto de `CronCreate` e `/loop` como mecanismo de despertar a sessão depois.

Settings observados: `scheduledTasksEnabled`, `sessionCronTasks`.

---

## 10. Outras / Internas

### Workflow
> Orquestra workflows dinâmicos/scriptados.

Scripts persistidos em caminho derivado de:
`projects/<hash>/workflows/scripts/<slug>-<hash>.js`.

Validações recuperadas:
- UNC paths não permitidos para `workflow scriptPath`.
- Arquivo de script tem limite de bytes.
- Arquivo inexistente gera `Workflow script file not found`.
- Subagente de workflow deve chamar `StructuredOutput` exatamente uma vez.

### Artifact
> Manipula artefatos/renderizáveis.

Integra com URLs `claude.ai/code/artifact/{uuid}` em `WebFetch`, mas a lógica detalhada
da tool não foi recuperada.

---

## Resumo Executivo

| Categoria | Tools/nomes observados |
|---|---|
| File System | `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `NotebookRead`, `NotebookEdit` |
| Shell | `Bash`, `PowerShell`, `BashOutput`, `KillShell`, `KillBash`, `Cd`, `REPL` |
| Busca/Web | `Grep`, `WebSearch`, `WebFetch` |
| Agente | `Task`, `TodoWrite`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `StructuredOutput` |
| Task List | `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskOutput` |
| MCP | `ListMcpResources`, `ReadMcpResource`, `WaitForMcpServers` |
| Time/Peers | `SendMessage`, `SendUserMessage`, `ListAgents`, `ListPeers` (baixa confiança), `AgentOutput` |
| GitHub/CI | `ConnectGitHub`, `ExitWorktree` |
| Cron | `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` |
| Outras | `Workflow`, `Artifact` |

**Leitura recomendada:** para lógica interna detalhada, veja `docs/tool-logic.md`.
