# Claude Code — Lógica Interna Recuperável das Tools

> Documento complementar a `docs/tools.md`.
> Fonte: engenharia reversa do `claude.exe` (Claude Code v2.1.181, Bun standalone),
> usando strings ASCII/UTF-16LE e janelas de contexto de bytecode/minified bundle.
>
> **Importante:** o binário é um Bun standalone com JavaScriptCore bytecode. Em várias
> regiões só foi possível recuperar strings e fragmentos de código minificado, não o
> AST completo. Por isso cada tool abaixo tem nível de confiança:
>
> - **Alta:** nome + descrição/guardrails/mensagens de erro recuperados diretamente.
> - **Média:** nome + parte da lógica recuperada; algum comportamento inferido pelo
>   contexto das strings.
> - **Baixa:** nome observado, mas lógica incompleta ou fragmentada.

---

## 1. Inventário recuperado

A extração local encontrou estes nomes/aliases relevantes de tool ou tool-like APIs:

| Categoria | Tools recuperadas |
|---|---|
| Arquivos | `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `NotebookRead`, `NotebookEdit` |
| Busca/Web | `Grep`, `WebSearch`, `WebFetch` |
| Shell/execução | `Bash`, `PowerShell`, `BashOutput`, `KillShell`, `KillBash`, `Cd`, `REPL` |
| Agentes/skills/plano | `Task`, `TodoWrite`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `StructuredOutput` |
| Task list interna | `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskOutput` |
| MCP | `ListMcpResources`, `ReadMcpResource`, `WaitForMcpServers` |
| Team/peer | `SendMessage`, `SendUserMessage`, `ListAgents`, `ListPeers`, `AgentOutput` |
| GitHub/worktree | `ConnectGitHub`, `ExitWorktree` |
| Cron/agendamento | `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` |
| Outras internas | `Workflow`, `Artifact` |

**Correção sobre a contagem:** `docs/tools.md` dizia “~35 tools”. A extração mostra
**40+ nomes/aliases**, mas nem todos são sempre expostos ao modelo: alguns são
internos, feature-gated, específicos de team/cron/workflow, ou aliases de output.
Portanto a contagem correta deve ser tratada como **aproximada e dependente do modo
runtime**, não como número fechado.

---

## 2. Arquivos

### 2.1 `Read` — confiança alta

**Nome interno:** `var $s = "Read"`  
**Descrição recuperada:** `Read a file from the local filesystem.`

#### Lógica/guardrails recuperados

- O parâmetro `file_path` deve ser **caminho absoluto** no Claude Code original.
- Lê arquivos locais e retorna conteúdo em formato semelhante a `cat -n`:
  - linhas numeradas a partir de 1;
  - número da linha + separador + conteúdo literal da linha.
- Lê imagens (`PNG`, `JPG`, etc.) e apresenta visualmente ao LLM multimodal.
- Lê PDFs quando suportado:
  - PDFs grandes (>10 páginas) exigem parâmetro `pages`;
  - máximo observado: **20 páginas por request**.
- Lê notebooks Jupyter (`.ipynb`) incluindo células, outputs, texto e visualizações.
- Não lê diretórios; para listar diretório o prompt orienta usar shell/registered shell tool.
- Screenshots passadas por path devem ser abertas com `Read`.
- Arquivo existente mas vazio gera system reminder no lugar de conteúdo normal.

#### Cache/anti-releitura

Strings recuperadas:

- `Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.`
- `File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.`
- `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`

**Interpretação:** o harness mantém estado de arquivo lido/editado e tenta reduzir
leituras redundantes. `Read` também participa da validação de edição: `Edit`/`Write`
exigem leitura anterior para arquivos existentes.

---

### 2.2 `Write` — confiança alta

**Nome interno:** `var Xc = "Write"`  
**Descrição recuperada:** `Writes a file to the local filesystem.` / variante:
`Writes a file to the local filesystem, overwriting if one exists.`

#### Lógica/guardrails recuperados

- Cria arquivo novo ou substitui arquivo inteiro.
- Se o arquivo já existe, exige leitura prévia via `Read`.
- Para mudança parcial, o prompt orienta preferir `Edit` porque envia só o diff.
- Guardrail explícito:
  - `NEVER create documentation files (*.md) or README files unless explicitly requested by the User.`
- Emojis:
  - `Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
- Há restrição contra glob patterns em operações de escrita:
  - `Glob patterns are not allowed in write operations. Please specify an exact file path.`

#### Erros relacionados a estado de arquivo

- `File has not been read yet. Read it first before writing to it.`
- `File content has changed since it was last read. This commonly happens when a linter or formatter run via Bash rewrites the file. Call Read on this file to refresh, then retry the edit.`

---

### 2.3 `Edit` — confiança alta

**Nome interno:** `var Ba = "Edit"`  
**Descrição observada:** `Performs a find-and-replace edit on a file.`

#### Lógica/guardrails recuperados

- Faz find-and-replace direcionado em arquivo existente.
- Depende do estado de leitura anterior: se o arquivo não foi lido ou mudou desde a
  última leitura, falha com os erros acima.
- Participa do mesmo conjunto de ferramentas de edição de código que `Write` e
  `NotebookEdit`, com contagem de decisões de permissão de edição.

#### Interpretação

O modelo de segurança de edição é **read-before-write**: antes de editar, o agente
deve ter uma visão recente do arquivo. Isso evita patches aplicados sobre estado
stale depois de formatadores/linters ou alterações externas.

---

### 2.4 `MultiEdit` — confiança baixa/média

`MultiEdit` aparece na extração como nome esperado/observado, mas a janela de strings
não trouxe descrição completa no material legível. Pelo ecossistema de tools e pelo
nome, é uma variante de múltiplas edições atômicas/encadeadas no mesmo arquivo, mas
**essa semântica deve ficar marcada como inferida** quando documentada.

Correção aplicada: não tratar `MultiEdit` como completamente validada sem trecho
verbatim adicional.

---

### 2.5 `Glob` — confiança alta

**Nome interno:** `var _u = "Glob"`  
**Descrição recuperada:**
`Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.`

#### Lógica/guardrails recuperados

- Busca arquivos por padrão de nome.
- Funciona em codebases grandes.
- Retorna paths ordenados por modificação (`mtime`).
- Recomendação explícita:
  - usar `Glob` quando precisa achar arquivos por padrão de nome;
  - usar `Agent`/`Task` quando a busca é aberta e pode exigir várias rodadas de glob + grep.
- Há mensagem de sandbox para padrões amplos demais:
  - `[Sandbox] Glob pattern too broad, skipping:`

---

### 2.6 `NotebookRead` — confiança média

A lógica aparece embutida no prompt de `Read`:

- `.ipynb` é lido como notebook completo;
- retorna células e outputs;
- combina código, texto e visualizações.

Pode ser exposto como tool separada em alguns modos, mas a evidência mais forte é o
suporte notebook dentro de `Read`.

---

### 2.7 `NotebookEdit` — confiança média

**Nome interno observado:** `var DD = "NotebookEdit"`

- Aparece junto de `Edit` e `Write` nas métricas de permissão:
  - `Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools`
- A lógica detalhada de edição de célula não foi totalmente recuperada.
- Deve ser documentada como edição de notebooks, com ressalva de que detalhes de
  schema/cell-id não foram recuperados neste pass.

---

## 3. Busca e web

### 3.1 `Grep` — confiança alta

**Nome interno:** `var Uc = "Grep"`

#### Descrição/guardrails recuperados

- Content search baseado em `ripgrep`.
- Prompt explícito:
  - usar `Grep` em vez de `grep`/`rg` via `Bash`;
  - integração correta com permissões e links de arquivo.
- Suporta regex completo:
  - exemplo: `log.*Error`, `function\s+\w+`.
- Filtros:
  - `glob` (`**/*.tsx`, etc.);
  - `type` (`js`, `py`, `rust`, etc.).
- Modos de output:
  - `content` — linhas correspondentes;
  - `files_with_matches` — só paths (default observado);
  - `count` — contagem de matches.
- Sintaxe é de ripgrep, não grep:
  - braces literais precisam de escape, ex.: `interface\{\}` para achar `interface{}` em Go.
- Multiline:
  - por padrão, padrões casam dentro de uma linha;
  - para cross-line, usar `multiline: true`.
- Para buscas abertas/múltiplas, o prompt recomenda usar `Task`/`Agent`.

---

### 3.2 `WebSearch` — confiança alta

**Nome interno:** `var q3 = "WebSearch"`

#### Lógica/guardrails recuperados

- Faz busca web e retorna blocos com título/URL/snippet.
- Suporta filtros de domínio para incluir/bloquear sites.
- String recuperada diz que WebSearch é **US-only**.
- Guardrail temporal:
  - usar o ano correto em queries de informação recente;
  - a string injeta o mês atual e instrui a pesquisar com o ano atual, não ano anterior.

---

### 3.3 `WebFetch` — confiança alta

**Nome interno:** `var JS = "WebFetch"`

#### Descrição recuperada

`Fetches a URL, converts the page to markdown, and answers prompt against it using a small fast model.`

#### Lógica/guardrails recuperados

- Falha para URLs autenticadas/privadas.
- Antes de usar, o agente deve checar se a URL aponta para serviço autenticado
  (`Google Docs`, `Confluence`, `Jira`, `GitHub`, etc.) e preferir tool autenticada/MCP/`gh` quando aplicável.
- HTTP é atualizado para HTTPS.
- Redirect cross-host é retornado para o agente em vez de seguido automaticamente;
  o agente deve chamar novamente com a URL de redirect.
- Respostas cacheadas por **15 minutos por URL**.
- Exceção observada:
  - `claude.ai/code/artifact/{uuid}` pode ser fetchado via login claude.ai; `curl` pode pegar SPA shell/Cloudflare 403.
- Setting relacionado:
  - `skipWebFetchPreflight` — pula blocklist/preflight em ambientes enterprise restritivos.

---

## 4. Shell / execução

### 4.1 `Bash` — confiança média/alta

**Nome interno:** `var Qo = "Bash"`

#### Lógica recuperada

- Executa comando shell e retorna output.
- O binário contém tabelas extensas de segurança/permissão para comandos shell e git,
  mas elas aparecem muito fragmentadas no bytecode recuperado; não foi possível
  reconstruir a matriz completa com segurança.
- Há integração com OpenTelemetry/telemetria (`OTEL_LOG_TOOL_DETAILS`) e sanitização de
  identificadores de tool.
- Em alguns prompts, `Grep` é preferido a `grep`/`rg` via `Bash` para busca de conteúdo.

#### Relação com Windows/PowerShell

A extração mostra lógica de seleção entre `Bash` e `PowerShell`:

```js
var Gs = "PowerShell";
function V1(){
  let e = process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL;
  if (platform !== "windows") return truthy(e);
  if (explicitFalse(e)) return false;
  if (explicitTrue(e)) return true;
  if (powershellUnavailable() === null) return true;
  return featureFlag("tengu_cobalt_ridge", false);
}
function eBe(){ return du() ? "bash" : "powershell" }
```

**Interpretação:** existe uma tool `PowerShell` separada/feature-gated. A frase
“em Windows adapta para PowerShell/cmd” deve ser corrigida para: o binário tem uma
seleção runtime entre Bash e PowerShell, controlada por OS, disponibilidade,
`CLAUDE_CODE_USE_POWERSHELL_TOOL` e feature flag.

---

### 4.2 `PowerShell` — confiança média

**Nome interno:** `var Gs = "PowerShell"`

- Tool distinta de `Bash`.
- Ativação depende de plataforma Windows, env var `CLAUDE_CODE_USE_POWERSHELL_TOOL`,
  disponibilidade de PowerShell e feature flag `tengu_cobalt_ridge`.
- Lógica detalhada de execução não foi totalmente recuperada.

---

### 4.3 `BashOutput` — confiança média

- Tool para ler output de comando shell/background.
- String observada:
  - `Read the output file to retrieve the result:`
- Usada quando comandos rodam assincronamente e o output fica em arquivo/stream
  consultável depois.

---

### 4.4 `KillShell` / `KillBash` — confiança média

- Termina processos shell em execução.
- String observada:
  - `killShellTasksForAgent: killing orphaned shell task`
- Indica limpeza de processos órfãos por agente/sessão.

---

### 4.5 `Cd` — confiança baixa/média

**Nome interno observado:** `var Wnl = "Cd"`

- Muda o diretório de trabalho corrente.
- Lógica detalhada de validação/path não foi recuperada de forma legível.

---

### 4.6 `REPL` — confiança média

**Nome interno:** `var MA = "REPL"`

#### Lógica recuperada

- Feature-gated por env/config:
  - `CLAUDE_REPL_VARIANT`
  - `CLAUDE_CODE_REPL`
  - `CLAUDE_CODE_ENTRYPOINT` (`cli`/`remote`)
  - flag `tengu_slate_harbor`
- Quando habilitado, usa um conjunto de ferramentas permitido:
  - `Read`, `Glob`, `Grep`, `Bash`, `PowerShell`, `NotebookEdit`.

---

## 5. Agentes, plano, perguntas e structured output

### 5.1 `Task` — confiança média

- Descrição em `docs/tools.md` já estava alinhada:
  - lança novo agente para tarefas complexas/multi-step;
  - cada agent type tem capacidades/tools específicas.
- A lógica detalhada de `Task` ficou parcialmente corrompida nos trechos recuperados,
  mas prompts de `coordinator`/`worker fork` confirmam o uso para spawnar workers.
- Tipos observados em docs/prompt strings: `fork`, `explore`, `implement`, `full`,
  `persistent`. A lista deve ser tratada como **observada**, não necessariamente
  fechada para todas as builds.

---

### 5.2 `TodoWrite` — confiança média/alta

**Nome interno:** `var aR = "TodoWrite"`

- Atualiza lista de tarefas da sessão.
- Prompt exige uso proativo para tracking.
- Campos recuperados/observados no doc:
  - `content` — forma imperativa;
  - `activeForm` — forma em progresso;
  - `status` — estado do item;
  - `id`/alias normalizado.
- System reminders aparecem se a tool não foi usada recentemente em trabalho que
  se beneficiaria de tracking.

---

### 5.3 `Skill` — confiança alta

**Nome interno:** `var uE = "Skill"`

Guardrails recuperados/validados:

- Só invocar skill que aparece na lista de skills disponíveis ou que o usuário digitou
  explicitamente como `/<name>`.
- Nunca inventar nome de skill a partir de training data.
- Quando uma skill casa com a solicitação, a invocação é **blocking requirement**
  antes de qualquer outra resposta.
- Não invocar skill já em execução.
- Após compaction, skills invocadas anteriormente são reinjetadas como contexto e o
  prompt proíbe reexecutar setup one-time.

---

### 5.4 `EnterPlanMode` — confiança alta

**Nome interno:** `var oY = "EnterPlanMode"`

- Tool não pode ser usada em agent contexts:
  - `EnterPlanMode tool cannot be used in agent contexts`
- Quando chamada, faz transição para `plan`:
  - `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.`
- Eventos observados em `docs/tools.md` (`Entered plan mode`, `User declined...`,
  `Exited plan mode`) estão coerentes.

---

### 5.5 `ExitPlanMode` — confiança média

**Nome interno:** `var _I = "ExitPlanMode"`; alias/string `OM = "ExitPlanMode"`.

- Existe como tool/nome interno.
- A lógica de transição é vista nos estados:
  - ao sair de plan mode, marca necessidade de attachment/registro de saída;
  - ao retornar, há prompt específico com plan file anterior.
- O prompt completo da tool não foi recuperado com a mesma clareza de `EnterPlanMode`,
  então detalhes de schema devem permanecer com ressalva.

---

### 5.6 `AskUserQuestion` — confiança alta

**Nome interno:** `var qf = "AskUserQuestion"`

#### Descrição recuperada

`Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.`

#### Guardrails recuperados

- Reservar para decisões em que a resposta do usuário muda o próximo passo.
- Não usar para fatos verificáveis no código nem escolhas com default convencional.
- Usuários sempre podem escolher `Other` para texto customizado.
- Suporta `multiSelect: true`.
- Se recomendar uma opção, ela deve ser a primeira e terminar com `(Recommended)`.
- Não usar para “Is this plan okay?”; para plano, usar `EnterPlanMode`.

#### Preview feature

- `preview` em opções quando o usuário precisa comparar artefatos concretos.
- `markdown` preview: ASCII mockups, snippets, diagramas, configs.
- `html` preview: fragmento HTML autocontido; sem `<html>`, `<body>`, `<script>` ou `<style>`.
- Preview só em single-select, não multiSelect.

---

### 5.7 `StructuredOutput` — confiança alta

**Nome interno:** `Wm = "StructuredOutput"`

#### Lógica recuperada

- Tool read-only/concurrency-safe/open-world false no fragmento de definição.
- Usa AJV para validar JSON Schema.
- Compila schema e valida input; se falhar:
  - `Output does not match required schema: ...`
  - `StructuredOutput schema mismatch: ...`
- Se passar:
  - retorna `data: "Structured output provided successfully"`
  - retorna `structured_output` com o objeto.
- `maxResultSizeChars` observado: `1e5`.
- Usado por workflow/subagents que precisam retornar resultado estruturado em vez de texto.

---

## 6. Task list interna

### 6.1 `TaskCreate` — confiança média

**Nome interno:** `var Gw = "TaskCreate"`

- Cria item em task list da sessão.
- Texto observado em `docs/tools.md`:
  - usado para listas estruturadas de tarefa;
  - recebe `subject` e `description`;
  - não delega trabalho — para delegar, usar `Task`.

### 6.2 `TaskGet` — confiança média

**Nome interno:** `var sY = "TaskGet"`

- Recupera task por ID.
- Lógica detalhada não foi totalmente recuperada.

### 6.3 `TaskUpdate` — confiança média

**Nome interno:** `var mL = "TaskUpdate"`

- Atualiza status/dados de task.
- Prompts de reminders indicam estados como `in_progress` e `completed`.

### 6.4 `TaskOutput` — confiança média

**Nome interno:** `var k8 = "TaskOutput"`

- Lê output de task/subagente assíncrono.
- Mensagem observada:
  - `TaskOutput failed`

---

## 7. MCP

### 7.1 `ListMcpResources` — confiança média

- Descrição recuperada:
  - lista resources de servidores MCP.
- Exemplos observados:
  - `listMcpResources`
  - `listMcpResources({ server: "myserver" })`

### 7.2 `ReadMcpResource` — confiança média

- Descrição recuperada:
  - lê resource de servidor MCP.
- Exemplo observado:
  - `readMcpResource({ server: "myserver", uri: "my-resource-uri" })`

### 7.3 `WaitForMcpServers` — confiança média

**Nome interno:** `var yCe = "WaitForMcpServers"`

- Aguarda servidores MCP ficarem disponíveis.
- Transports observados:
  - `StdioClientTransport`
  - `SSEClientTransport`
  - `StreamableHTTPClientTransport`

---

## 8. Team / peers

### 8.1 `SendMessage` — confiança alta

**Nome interno:** `var zh = "SendMessage"`

- Envia mensagem a teammates ou peers, dependendo do contexto.
- Prompt de team exige `to: "<name>"` para teammates ativos.
- Responder em texto normal **não é visível** ao team; precisa usar `SendMessage`.
- Em coordinator, também é usado para continuar worker existente (`to` agent ID) e
  falar com peers cross-session.

### 8.2 `SendUserMessage` — confiança média

**Nome interno:** `var TU = "SendUserMessage"`

- Envia mensagem ao usuário final em fluxos multi-agente/non-interactive.
- Lógica detalhada não recuperada completamente.

### 8.3 `ListAgents` — confiança média

**Nome interno:** `var Ett = "ListAgents"`

- Lista agentes/sessões disponíveis em team/cross-session.
- Prompt de coordinator usa ferramenta equivalente para descobrir peers.

### 8.4 `ListPeers` — confiança baixa

- Nome mencionado em documentação anterior, mas a extração não confirmou `var` direto
  nesta rodada (`quoted=0` no relatório). Deve ser tratado como possível alias ou
  conceito, não como tool validada com o mesmo nível de `ListAgents`.

### 8.5 `AgentOutput` — confiança baixa/média

- Nome aparece como output de agente/tool-like output.
- Lógica detalhada não recuperada.

---

## 9. GitHub / worktree

### 9.1 `ConnectGitHub` — confiança baixa/média

**Nome interno:** `var ytt = "ConnectGitHub"`

- Tool de conexão/autenticação GitHub.
- A extração encontrou telemetria de operações Git:
  - `commit`, `commit_amend`, `push`, `pr_create`, `pr_edit`, `pr_merge`,
    `pr_comment`, `pr_close`, `pr_ready`.
- Não foi recuperado schema completo da tool.

### 9.2 `ExitWorktree` — confiança média

**Nome interno:** `var Cvn = "ExitWorktree"`

- Sai de sessão em worktree.
- Mensagens observadas:
  - `ExitWorktree: original directory...`
  - `Already in a worktree session. Pass path to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.`

---

## 10. Cron / agendamento

### 10.1 `CronCreate` — confiança média/alta

- Descrição recuperada:
  - agenda prompt para rodar no futuro;
  - pode ser recorrente via cron ou one-shot em horário específico.
- Durabilidade:
  - por padrão, task é de sessão;
  - com `durable: true`, persiste em `.claude/scheduled_tasks.json`.
- Feature flags:
  - `tengu_kairos_cron`
  - `tengu_kairos_cron_durable`
- Config observada:
  - `scheduledTasksEnabled`
  - `sessionCronTasks`

### 10.2 `CronDelete` — confiança média

- Remove tarefa agendada.
- Lógica completa não recuperada.

### 10.3 `CronList` — confiança média

- Lista tarefas agendadas.
- String observada:
  - `Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will wake this session later. Empty array when none are scheduled.`

### 10.4 `ScheduleWakeup` — confiança média

**Nome interno:** `var Pg = "ScheduleWakeup"`

- Agenda wakeup da sessão.
- Aparece junto de `CronCreate` e `/loop` como mecanismo de despertar sessão depois.

---

## 11. Outras internas

### 11.1 `Workflow` — confiança média

**Nome interno:** `var Vk = "Workflow"`

- Orquestra workflow dinâmico/scriptado.
- Scripts são persistidos em caminho derivado de:
  - `projects/<hash>/workflows/scripts/<slug>-<hash>.js`
- Há validações recuperadas:
  - UNC paths não são permitidos para `workflow scriptPath`;
  - script file tem limite de bytes (`a2+1` no fragmento);
  - arquivo inexistente gera `Workflow script file not found`;
  - falha em persistência loga warning.
- Subagente de workflow tem prompt rígido: deve chamar `StructuredOutput` exatamente uma vez.

### 11.2 `Artifact` — confiança baixa/média

**Nome interno:** `var PAe = "Artifact"`

- Manipula artefatos/renderizáveis.
- Integração com `claude.ai/code/artifact/{uuid}` aparece em `WebFetch`.
- Lógica detalhada não recuperada.

---

## 12. Conclusões de validação contra `docs/tools.md`

### Correções feitas/recomendadas

1. Trocar contagem rígida `~35 tools` por `40+ nomes/aliases observados, dependente do runtime`.
2. `Read`: adicionar caminho absoluto, imagens, PDFs, limite de páginas, notebooks,
   não-diretórios, screenshots e mensagens de cache.
3. `Write`: adicionar read-before-write, preferência por `Edit`, proibição de docs/README
   sem pedido explícito e política de emojis.
4. `Edit`: explicitar read-before-write e erro quando arquivo mudou desde última leitura.
5. `Glob`: adicionar recomendação de `Task`/`Agent` para buscas abertas e ordenação por mtime.
6. `Grep`: expandir ripgrep, output modes, escape de braces e multiline.
7. `PowerShell`: documentar como tool separada/feature-gated, não apenas adaptação genérica.
8. `StructuredOutput`: documentar AJV/schema validation e `maxResultSizeChars: 1e5`.
9. `Cron`: incluir `ScheduleWakeup` e distinção session-scoped vs durable.
10. `ListPeers` e `MultiEdit`: rebaixar confiança/ressalvar porque a extração desta rodada
    não trouxe definição completa.

### Limite do que foi possível extrair

Não foi possível reconstruir com segurança a implementação completa de:

- matriz de permissões de `Bash`/`PowerShell`;
- schema completo de `Task`;
- schema completo de `NotebookEdit`;
- implementação detalhada de `Artifact`;
- todos os aliases internos (`__bash`, `__web_fetch`) com mapeamento exhaustivo.

Essas lacunas devem permanecer marcadas nos MDs para não transformar inferência em fato.
