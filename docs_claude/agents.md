# Claude Code — Agentes, Identidades e Modos

> Documentação extraída via engenharia reversa do binário `claude.exe`
> (Claude Code v2.1.181, Bun standalone, JavaScriptCore bytecode).
> Fonte: tabelas de strings ASCII + UTF-16LE embutidas no binário.
>
> Revalidação: veja `docs/prompt-audit.md`. Quando este documento fala em
> “seleção runtime” ou “tipo de agente”, isso significa **comportamento observado
> nesta build** e/ou inferência a partir dos prompts recuperados, não contrato público
> estável entre versões.

---

## Visão Geral

O Claude Code não é um único agente — é um **sistema multi-agente** onde diferentes
*identidades*, *modos de permissão* e *estilos de output* são combinados em runtime
para definir como o agente se comporta numa sessão específica.

A combinação é:

```
Identidade + Modo de Permissão + Output Style = Perfil do Agente ativo
```

Cada componente é descrito abaixo.

---

## 1. Identidades (System Prompts)

O binário contém **três variantes** de prompt de identidade. A seleção por
contexto de execução é uma inferência forte a partir das strings e do fluxo observado;
a tabela de dispatch completa não foi reconstruída. Extraídas do offset `~83373632`
(UTF-16LE):

### 1.1 — CLI Standalone (padrão)

> **You are Claude Code, Anthropic's official CLI for Claude.**

Usada quando o CLI roda diretamente no terminal (`claude` no shell).

### 1.2 — SDK Runtime

> **You are Claude Code, Anthropic's official CLI for Claude, running within the
> Claude Agent SDK.**

Usada quando o CLI é spawnado pelo Claude Desktop (via `claude-agent-sdk`).
O Desktop invoca este binário como subprocesso `bun`/`node`.

### 1.3 — Agente Puro (subagentes / Task)

> **You are a Claude agent, built on Anthropic's Claude Agent SDK.**

Usada por subagentes delegados via tool `Task`. Não tem a identidade "Claude Code" —
é um agente de propósito mais restrito, focado na tarefa delegada.

---

## 2. Modos de Permissão

Controlam o nível de autonomia do agente para executar ações sem confirmação humana.
Extraídos do código minificado (`function ami(e)`):

| Modo | Comportamento |
|---|---|
| **`default`** | Pede confirmação para ações que modificam estado (escrita, comandos shell). Leitura e busca são livres. |
| **`acceptEdits`** | Edita arquivos sem pedir confirmação. Ainda pede para comandos shell perigosos. |
| **`plan`** | Modo somente-leitura. O agente **explora e planeja** mas não executa alterações. Precisa chamar `EnterPlanMode` e depois sair com aprovação. Flag de estado: `planModeRequired`. |
| **`bypassPermissions`** | Ignora toda confirmação. Exige disclaimer aceito interativamente (`bypassPermissionsModeAccepted`). |
| **`auto`** | Autonomia máxima com julgamento próprio. Exige modelo capaz (Opus 4.7+, gateado por `OW()`). |

**Notas de runtime:**
- `Permission mode downgraded to default — bypass/auto requires accepting the
  disclaimer interactively first.` — se o disclaimer não foi aceito, cai para `default`.
- A transição entre modos é rastreada: `needsPlanModeExitAttachment`,
  `needsAutoModeExitAttachment` controlam anexos pós-transição.

---

## 3. Output Styles

Três estilos alteram **como** o agente responde. O padrão é selecionável via `/config`
ou setting `outputStyle`. Extraídos de `interactive CLI tool` (offset `~201548059`):

### 3.1 — Proactive (padrão)

> **You are an interactive CLI tool that helps users with software engineering tasks.
> You should work proactively and autonomously, executing immediately and minimizing
> interruptions.**

Descrição embutida: *"Claude executes immediately, minimizes interruptions, and
prefers action over planning."*

### 3.2 — Explanatory

> **You are an interactive CLI tool... In addition to software engineering tasks,
> you should provide educational insights about the codebase along the way.**
> **You should be clear and educational... Balance educational content with task
> completion. When providing insights, you may exceed typical length constraints,
> but remain focused and relevant.**

Descrição: *"Claude explains its implementation choices and codebase patterns."*

### 3.3 — Learning

> **Learn by Doing** — o agente **pausa** e pede ao usuário para escrever pequenos
> pedaços de código (`TODO(human)` sections).

Descrição: *"Claude pauses and asks you to write small pieces of code for hands-on
practice."*

Estrutura de pedidos:
```
**Learn by Doing**
### Context
### Your Task
### Guidance
### Key Guidelines
  - frame as design decisions
  - add TODO(human) section first
  - exactly one such section
```

---

## 4. Modo Autônomo (feature flag `tengu_amber_sextant`)

Ativado quando o agente roda sem supervisão humana em tempo real (ex.: CI, cron,
agentes gerenciados). Diretiva completa extraída do offset `~441386`:

> **You are operating autonomously. The user is not watching in real time and cannot
> answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the
> work. For reversible actions that follow from the original request, proceed without
> asking. Stop only for destructive actions or genuine scope changes the user must
> decide. Offering follow-ups after the task is done is fine; asking permission before
> doing the work is not.**

**Exceção:**
> *When the user is describing a problem, asking a question, or thinking out loud
> rather than requesting a change, the deliverable is your assessment. Report your
> findings and stop. Don't apply a fix until they ask for one.*

**Regra de fechamento de turno:**
> *Before ending your turn, check your last paragraph. If it is a plan, an analysis,
> a question, a list of next steps, or a promise about work you have not done
> ('I'll…', 'let me know when…'), do that work now with tool calls. That includes
> retrying after errors and gathering missing information yourself. Do not stop because
> the context or session is long. End your turn only when the task is complete or you
> are blocked on input only the user can provide.*

**Verificação antes de ações destrutivas:**
> *Before running a command that changes system state — restarts, deletes, config
> edits — check that the evidence actually supports that specific action. A signal
> that pattern-matches to a known failure may have a different cause.*

---

## 5. Tipos de Subagente (Agent Types)

A tool `Task` pode spawnar subagentes com tipos específicos. Tipos confirmados:

| Tipo | Função |
|---|---|
| **`fork`** | Subagente completo que herda ferramentas (equivalente ao agente principal) |
| **`explore`** | Somente-leitura — investigação, busca, mapeamento |
| **`implement`** | Leitura + escrita + shell, escopado a arquivos específicos |
| **`full`** | Sem filtro — herda o toolset exato do agente pai |
| **`persistent`** | Subordinado persistente (requere Company master) |

Regras de uso (extraídas do prompt da tool):
- *Use 1 agent when the task is isolated to known files... you're making a small
  targeted change.*
- *Use multiple agents to investigate independent topics in parallel.*
- *Don't use `implement` for read-only work — `explore` is cheaper.*

---

## 6. Time de Agentes (Team / Multi-Agent)

Quando rodando em time (Cowork, managed agents), a diretiva muda:

> **You are running as an agent in a team. To communicate with anyone on your team,
> use the SendMessage tool with `to: "<name>"` to send messages to specific teammates.**

> **Just writing a response in text is not visible to others on your team - you MUST
> use the SendMessage tool.**

### Roles em time:
- **Worker / Implementation** — *Make targeted changes per spec, commit*
- **Coordinator** — distribui tarefas, agrega resultados
- **Reviewer** — revisa PRs / código

### Tools de time:
`SendMessage`, `SendUserMessage`, `ListAgents`, `ListPeers`, `TaskCreate`,
`TaskGet`, `TaskUpdate`, `TaskOutput`

---

## 7. Prompts Especializados

Prompts secundários embutidos para funções específicas:

### 7.1 — Geração de título de sessão

> **You are coming up with a succinct title and git branch name for a coding session
> based on the provided description. The title should be clear, concise... no more
> than 6 words.**

### 7.2 — Busca de sessões passadas

> **You are searching for past Claude Code conversation sessions on behalf of the
> user.**

### 7.3 — Classificador de Auto Mode

> **You are an expert reviewer of auto mode classifier rules for Claude Code.**

### 7.4 — Browser tool guardrail

> *When using browser automation tools, stay focused on the specific task. If you
> encounter unexpected complexity or tangential browser exploration, stop and ask the
> user for guidance.*

### 7.5 — Skill invocation (regra blocking)

> *Only invoke a skill that appears in that list, or one the user explicitly typed as
> `/<name>` in their message. Never guess or invent a skill name from training data;
> otherwise do not call this tool.*

> *When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the
> relevant Skill tool BEFORE generating any other response.*

---

## 8. Diretiva de Idioma

Template injetado conforme configuração:

```
# Language
Always respond in {{language}}. Use {{language}} for all explanations...
Maintain full orthographic correctness...
Never substitute accented characters with their ASCII equivalents
(e.g., never write "nao" for "não"...).
```

---

## 9. Arquitetura de Execução

```
┌─ claude.exe (Bun standalone, 214MB) ───────────────────────┐
│                                                             │
│  Entrypoint: src/entrypoints/agentSdk.ts                   │
│                                                             │
│  Identidade (3 variantes) ──┐                              │
│  Modo de permissão ─────────┼──► System Prompt montado     │
│  Output style ──────────────┤      em runtime               │
│  Diretivas (autonomous, ────┘                              │
│    language, skills...)                                     │
│                                                             │
│  Loop agentico:                                             │
│    prompt → API Anthropic → stream tokens                   │
│      → tool_use → executar → tool_result → repetir          │
│      → message_stop                                         │
│                                                             │
│  Subagentes via Task (fork/explore/implement/full)          │
│  Multi-agente via Team (SendMessage/ListAgents)             │
└─────────────────────────────────────────────────────────────┘
```

---

## Limites da Análise

O system prompt completo não é um blob contíguo no binário — é **montado em runtime**
a partir de strings atomizadas (Bun AtomTable). Os textos acima foram extraídos
verbatim das tabelas de strings, mas a ordenação exata de assembly em runtime não é
recuperável sem emular a lógica do Bun.

O **código fonte TypeScript** é compilado para **JavaScriptCore bytecode** — não é
legível. Apenas strings literais sobrevivem.
