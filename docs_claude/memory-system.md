# Claude Code — Sistema de Memória

> Documentação extraída via engenharia reversa do binário `claude.exe`
> (Claude Code v2.1.181, Bun standalone).
> Textos verbatim das tabelas de strings UTF-16LE (offset `~303457`).
>
> Revalidação: veja `docs/prompt-audit.md`. A arquitetura de alto nível foi
> confirmada; detalhes de schema/frontmatter podem variar por build.

---

## Visão Geral

O Claude Code possui um **sistema de memória persistente baseado em arquivos**.
Diferente do contexto da conversa (efêmero), a memória sobrevive entre sessões e
permite que o agente acumule conhecimento sobre o usuário, o projeto e convenções
ao longo do tempo.

Três mecanismos complementares:

```
CLAUDE.md  +  Agent Memory (arquivos)  +  Session State (transient)
   ▲                ▲                          ▲
   │                │                          │
 arquivo único   diretório de memórias      runtime only
 instructions    learnings granulares        não persiste
```

---

## 1. CLAUDE.md

Arquivo de instruções de contexto. Carregado automaticamente no início de cada
sessão.

### Hierarquia de carregamento

```
User scope       ~/.claude/CLAUDE.md          (global, todas as sessões)
Project scope    <projeto>/CLAUDE.md          (versionado com o repo)
Local scope      <projeto>/.claude/CLAUDE.local.md  (não commitado)
Managed scope    <policy>/CLAUDE.md           (enterprise, admin-only)
```

Setting de exclusão:
> *"Glob patterns or absolute paths of CLAUDE.md files to exclude from loading.
> Patterns are matched against absolute file paths using picomatch. Only applies to
> User, Project, and Local memory types (Managed/policy files cannot be excluded).
> Examples: `/home/user/monorepo/CLAUDE.md`, `**/code/CLAUDE.md`,
> `**/some-dir/.claude/rules/**`"*

### `settingSources`

Controla quais escopos carregar:
```ts
settingSources: ["user", "project", "local"]
```

---

## 2. Agent Memory (Sistema de Arquivos)

Memória persistente granular. Cada fato/aprendizado vai em **seu próprio arquivo**.

### Localização dos arquivos

```
User scope      ~/.claude/agent-memory/<kebab-slug>/
Project scope   <projeto>/.claude/agent-memory/<kebab-slug>/    (versionado)
Local scope     <projeto>/.claude/agent-memory-local/<kebab-slug>/  (machine)
Remote (opt)    $CLAUDE_CODE_REMOTE_MEMORY_DIR/projects/<hash>/agent-memory-local/
```

Display name: **"Persistent Agent Memory"**

### Convenção de nomes de arquivo

> **Write each memory to its own file. Use a 3-4 word filename... (e.g.,
> `prefers-bun-over-npm.md`, `compliance-driven-rewrite.md`). Don't prefix the
> filename with the memory type — that's already in the frontmatter.**

### Frontmatter template

```yaml
---
name: <short-kebab-case-slug>
description: <one-line summary>
type: <memory-type>
---
```

### Diretrizes de uso

> *"You should build up this memory system over time so that future conversations can
> have a complete picture of who the user is, how they'd like to collaborate with you,
> what behaviors to avoid or repeat."*

> *"If the user explicitly asks you to remember something, save it immediately. If
> they ask you to forget something, find and remove the relevant entry."*

> *"Do not write duplicate memories. First check if there is an existing memory that
> already covers what you want to save."*

> *"Delete existing memories that are superseded by the memory you have saved."*

### Granularidade

> *Each memory file should contain one paragraph about a single fact. Avoid writing
> one very long paragraph.*

### Imutabilidade

> *"Memory files should be treated as immutable. You should never edit a memory file
> in-place. Instead, delete any memory files that have become stale and write a
> fresh one if you still need the information."*

---

## 3. Tipos de Memória

> *Save a memory when you learn one of the following — pick the matching type:*

| Tipo | Quando usar |
|---|---|
| **`architecture`** | Decisões arquiteturais e seus porquês |
| **`decision`** | Decisões tomadas (e rationale) |
| **`pattern`** | Padrões de código/design adotados |
| **`convention`** | Convenções do projeto/time |
| **`todo`** | TODOs e follow-ups pendentes |
| **`note`** | Notas gerais / observações |
| **`gotcha`** | Armadilhas, comportamentos não-óbvios |
| **`procedure`** | Receitas/how-to que funcionaram |

> *Invoke the `{{skill}}` skill for scope, body structure and examples once you've
> decided to save.*

### Scoping por tipo

| Escopo | Diretriz |
|---|---|
| **user** | *Since this memory is user-scope, keep learnings general since they apply across all projects.* |
| **project** | *Since this memory is project-scope and shared with your team via version control, tailor your memories to this project.* |
| **local** | *Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine.* |

---

## 4. Caveat Crítico: Memórias Stale

**Diretiva embutida (literal):**

> *"Memory records can become stale over time. Use memory as context for what was
> true at a given point in time. Before answering the user or building assumptions
> based solely on information in memory records, verify that the memory is still
> correct and up-to-date by reading the current state of the files or resources."*

> *"If a recalled memory conflicts with current information, trust what you observe
> now — and update or remove the stale memory rather than acting on it."*

Variante (escopo project):
> *...trust what you observe now — and delete the stale memory file (saving a fresh
> one if you still need the information) rather than acting on it.*

---

## 5. Memória vs. Outras Formas de Persistência

> *"Memory is one of several persistence mechanisms. Memory can be recalled in
> future conversations and should not be used for persisting information that is only
> useful within the scope of the current conversation."*

| Mecanismo | Escopo | Quando usar |
|---|---|---|
| **Memory files** | Cross-session | Conhecimento durável sobre user/projeto |
| **Plan** | Current session | Plano de trabalho atual (delega, não persiste entre sessões) |
| **Tasks** | Current session | Estado de execução da tarefa corrente |
| **Session transcript** | Current session | Histórico da conversa (efêmero) |

---

## 6. Memória Remota / Cowork

Em ambientes Cowork (multi-agente), a memória pode ser remota:

```env
CLAUDE_CODE_REMOTE_MEMORY_DIR=/path/to/remote
```

Estrutura: `$REMOTE/projects/<hash>/agent-memory-local/`

Guidelines extra injetados via:
```env
CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES="..."
```

---

## 7. Exclusão via `/memories/export`

- `/memories` — lista memórias salvas
- `/memories/export` — exporta todas as memórias (para backup/migração)
- `/memory` — abre/edita o arquivo CLAUDE.md principal

---

## 8. Fluxo de Decisão (quando salvar)

```
Aprendi algo novo?
    │
    ├─ É específico desta conversa?  ──► NÃO salvar (use Task/Plan)
    │
    ├─ É durável/cross-session?      ──► SIM, continuar
    │
    ├─ Já existe memória similar?    ──► Atualizar (deletar + recriar)
    │
    ├─ Qual o escopo?
    │     ├─ User (geral)            ──► ~/.claude/agent-memory/
    │     ├─ Project (versionado)    ──► <repo>/.claude/agent-memory/
    │     └─ Local (esta máquina)    ──► <repo>/.claude/agent-memory-local/
    │
    ├─ Qual o tipo? (architecture/decision/pattern/convention/...)
    │
    └─ Criar arquivo:
          filename: <3-4-words>.md
          frontmatter: name + description + type
          body: 1 parágrafo, 1 fato
```

---

## Resumo das Regras de Ouro

1. **Um fato por arquivo** — granularidade alta
2. **Imutável** — nunca edite in-place; delete + recrie
3. **Verifique antes de agir** — memórias podem estar stale
4. **Sem duplicação** — cheque antes de salvar
5. **Trust observations over memory** — conflito → memória perde
6. **Escopo correto** — user/project/local conforme aplicabilidade
7. **3-4 palavras no filename** — sem prefixo de tipo (já está no frontmatter)
