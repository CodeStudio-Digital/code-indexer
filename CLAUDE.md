# MCP Code Indexer v3.12 — Instruções para Claude

## O que é

O code-indexer é uma MCP de indexação de código que analisa projetos com LLMs e disponibiliza **41 tools** para navegação semântica do codebase, otimizadas para **economia de tokens**. Sempre que precisar entender um projeto indexado, **use as tools MCP antes de ler arquivos diretamente**.

## Projetos indexados

O `project_name` segue o formato `Owner/Repo` (ex: `CodeStudio/MCP-CodeBase`). Use `list_projects` se não souber o nome exato.

## Fluxo recomendado (token-efficient)

1. **`get_project_pulse`** — visão ultra-compacta (~100 tokens). Sempre comece aqui.
2. **`query_snapshots`** — pergunte ao conhecimento já indexado **antes** de explorar código.
3. **`get_context_for`** — para perguntas exploratórias ("como funciona X?") — bundle curado.
4. **`get_file_skeleton`** — outline de arquivo (6× mais barato que `get_file_structure`).
5. **`prepare_edit`** — bundle completo para editar um symbol (body + callers + neighbors + imports + tests).

> Evite `get_project_overview`/`get_project_context` sem `compact: true` ou `max_tokens` — são verbosos.

## Tools v3.3 (token economy) — PREFIRA ESTAS

| Tool | Propósito | Tokens |
|---|---|---|
| `get_project_pulse` | Visão ultra-compacta do projeto | ~100 |
| `get_file_skeleton` | Outline de arquivo (header + symbols) | ~250 |
| `get_symbol_body` | Extrai apenas o corpo de uma função/classe | ~100-500 |
| `prepare_edit` | One-shot bundle para editar symbol (body+callers+neighbors+imports+tests) | ~800 |
| `get_context_for` | Pergunta NL → snapshots+files+symbols curados | ~1500 |
| `query_snapshots` | FTS sobre snapshots (compact por default) | ~1100 |
| `grep_code` | Busca textual com filtros (literal/case/lang/layer/glob) | variável |
| `read_file` | Slice de arquivo (default 100L; até 400L sem range; >400L exige range ou `force: true`) | variável |
| `list_directory` | Listar arquivos por prefixo (sem disco) | ~50 |
| `get_recently_modified_files` | Arquivos recentemente indexados | ~50 |

## Tools clássicas (30)

### Descoberta e Visão Geral

| Tool | Quando usar |
|---|---|
| `list_projects` | Listar projetos indexados |
| `get_project_stats` | Métricas (arquivos, symbols, conceitos) |
| `get_project_overview` | Visão completa — use `compact: true` ou `max_tokens` |
| `get_architecture` | Arquitetura por camadas |
| `get_project_context` | Todos snapshots — use `max_tokens` |

### Busca

| Tool | Quando usar |
|---|---|
| `search` | Buscar no projeto (`mode`: fts/vector/hybrid; `type`: files/symbols/all) |
| `search_global` | Buscar em todos os projetos |
| `search_concepts` | Encontrar arquivos por conceito semântico |
| `search_by_kind` | Filtrar symbols por tipo (function, class, interface...) |

### Navegação de Código

| Tool | Quando usar |
|---|---|
| `get_file_structure` | Detalhes completos de arquivo (verboso — prefira `get_file_skeleton`) |
| `get_symbol_details` | Detalhes de symbol por ID |
| `get_class_members` | Membros de uma classe |

### Dependências e Referências

| Tool | Quando usar |
|---|---|
| `get_dependencies` | O que um arquivo importa |
| `get_dependents` | Quem importa/usa um arquivo |
| `find_references` | Refs de um symbol (com `file:line: contexto`) |
| `trace_usage` | Árvore recursiva de uso (`depth` default 3) |

### Hierarquia

| Tool | Quando usar |
|---|---|
| `get_hierarchy` | extends/implements/subclasses |
| `find_implementations` | Implementações concretas de uma interface |

### Snapshots

| Tool | Quando usar |
|---|---|
| `list_snapshots` | Listar snapshots (compact por default) |
| `add_snapshot` | Criar (category: architecture/decision/pattern/convention/todo/note) |
| `update_snapshot` | Atualizar |
| `delete_snapshot` | Remover |
| `get_snapshot_history` | Histórico de versões |

### Indexação e Admin

| Tool | Quando usar |
|---|---|
| `index_project` | Indexar/reindexar (`force?`) |
| `delete_project` | Remover do índice |
| `get_diff` | Diff entre runs |
| `get_costs` / `estimate_cost` | Custos |
| `export_docs` | Exportar documentação |
| `list_models` | Modelos LLM disponíveis |

## Regras de uso

### Prefira MCP a leitura direta
- **Entender arquivo**: `get_file_skeleton` (não `get_file_structure` nem `Read`)
- **Ler corpo de função**: `get_symbol_body` (não `Read` do arquivo inteiro)
- **Editar symbol**: `prepare_edit` (substitui 5+ chamadas)
- **Pergunta exploratória**: `get_context_for` antes de explorar manualmente
- **Onde algo é usado**: `find_references`/`trace_usage` (não `Grep`)
- **Dependências**: `get_dependencies`/`get_dependents`
- **Texto em múltiplos arquivos**: `grep_code` com filtros (`language`, `layer`, `glob`)

### Busca semântica vs textual
- `mode: "fts"` — textual exata (FTS5), melhor para nomes
- `mode: "vector"` — semântica por embeddings, melhor para NL
- `mode: "hybrid"` — RRF (default, melhor opção)

### Economia de tokens
- Sempre que disponível, passe `compact: true` ou `max_tokens` em tools verbosas
- `get_project_pulse` antes de `get_project_overview`
- `query_snapshots` antes de explorar código manualmente
- `prepare_edit` substitui sequência de `get_file_structure` + `find_references` + reads
- Para arquivos críticos pequenos (<400L) use `read_file` direto; para >400L use `force: true` se precisar do arquivo inteiro

### Fallbacks robustos (v3.3+)
Algumas tools têm fallback regex automático quando o índice da DB está incompleto:
- **`get_symbol_body`** — se symbol não está na DB, varre arquivos do projeto via regex
- **`get_file_skeleton`** — se DB tem <3 symbols num arquivo >80L, suplementa com regex
- **`find_references`** — se `symbol_references` retorna 0, faz grep no projeto inteiro
- Output marcado com `[regex fallback]` ou `[grep fallback]` para transparência

### Convenções de `file_path`
- Sempre relativo à raiz do projeto, com `/` (ex: `src/agent/indexer.ts`)

### Snapshots como memória
- Decisões importantes → `add_snapshot` (`decision`)
- Patterns identificados → `add_snapshot` (`pattern`)

## Coder Agent (v3.4)

Camada nova em `src/coder/` que adiciona um **agente de programação** sobre as 41 tools de leitura. Combina:

- **Tools nativas**: `write_file`, `edit_file`, `create_file`, `run_command`, `git_status/diff/log/add/commit/branch`
- **Bridge MCP**: spawn do `dist/mcp/server.js` via stdio → todas as 41 tools do indexer ficam disponíveis com prefixo `mcp__` (project_name é injetado automaticamente)
- **Multi-provider**: Anthropic (`claude-sonnet-4-6`), ZAI/GLM (`glm-5.1`), OpenAI, DeepSeek
- **Sessões persistidas** por projeto (tabelas `coder_sessions`/`coder_messages`/`coder_tool_calls`, migration 004)
- **Sandbox**: tools de fs/shell são travadas no `root_path` do projeto

### CLI

```bash
mcp-code-indexer agent "adicione um teste para truncateToTokens em src/mcp/server.ts"
mcp-code-indexer agent -p anthropic -m claude-sonnet-4-6 "..."
mcp-code-indexer agent --session 5 "continue de onde parou"
mcp-code-indexer agent --project CodeStudio/MCP-CodeBase -p zai "refatore X"
```

Sem `--project` o CLI casa o `cwd` com `projects.root_path` automaticamente.

### Dashboard

Aba **Chat** em cada projeto (`http://localhost:3333`):
- Sidebar com sessões persistidas (escopo do projeto)
- Picker de provider/modelo por sessão
- Streaming SSE em tempo real (texto + tool calls colapsáveis)
- Botão Abort para interromper o run
- **Header com `⚡ cache read`** persistido (sobrevive a reload e abertura de
  sessões antigas) — soma DB + delta runtime durante a execução
- **Tooltip do header** com hit rate %, ~tokens economizados (cached × 0.5),
  contagem de mensagens/turnos/tool calls/errors/distinct tools/subagentes,
  tempo em tools e duração total da sessão (de `/api/coder/sessions/:id/stats`)
- **Badge `⚡N` per-message** ao lado de `↑X ↓Y` quando o assistant message
  acertou cache

### Endpoints HTTP novos

- `GET    /api/coder/providers`
- `GET    /api/coder/sessions?project_id=N`
- `POST   /api/coder/sessions` `{project_id, title, provider, model}`
- `GET    /api/coder/sessions/:id` (com mensagens)
- `GET    /api/coder/sessions/:id/stats` (v3.7) → `CoderSessionStats` agregado
  (tokens, cache, contagens de tools, duração) computado em SQLite
- `DELETE /api/coder/sessions/:id`
- `POST   /api/coder/sessions/:id/messages` `{content}` → **SSE stream**
- `POST   /api/coder/sessions/:id/continue` (v3.6) → resume após `/answer`/`/plan-response`
- `POST   /api/coder/sessions/:id/answer`, `/plan-response` (v3.6 com fallback de resume)
- `POST   /api/coder/sessions/:id/switch` `{provider, model}`
- `POST   /api/coder/sessions/:id/abort`

### API keys

`ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` no `.env`.

### Memória de longo prazo

O system prompt instrui o agente a salvar decisões/patterns importantes via `mcp__add_snapshot` — conhecimento que ultrapassa a sessão vira snapshot do projeto.

### Tuning de tokens (v3.4.1)

O coder agora aplica **truncamento monótono no push-time** dos tool_results e injeta defaults de `max_tokens` em tools verbosas antes de chamar o servidor MCP. Isso preserva o cache de prefixo de ZAI/GLM (auto) e Anthropic (ephemeral), evitando que cada turno re-fature todo o histórico.

Env vars (todas opcionais, defaults seguros):

| Var | Default | Função |
|---|---|---|
| `CODER_PUSH_TIME_CAP` | `8000` | Tamanho máx (chars) de um `tool_result`. Acima disso é truncado com marcador determinístico. |
| `CODER_TURN_BUDGET_CHARS` | `30000` | Orçamento total por turno. Acima disso emite warning. |
| `CODER_MCP_OUTPUT_HARD_CAP` | `12000` | Hard cap absoluto no output de qualquer tool MCP no bridge. |
| `CODER_READ_FILE_HARD_MAX` | `300` | Limite de `max_lines` aceito em `mcp__read_file` (clamp no bridge). |
| `CODER_MCP_DEFAULT_MAX_TOKENS` | (built-in) | JSON `{"tool_name": N}` para sobrescrever os defaults injetados (`get_project_overview: 2000`, `get_project_context: 3000`, etc.). |
| `CODER_DISABLED_MCP_TOOLS` | (vazio) | CSV de tools MCP a esconder do agente. Ex: `add_snapshot,index_project,delete_project`. |
| `CODER_TERSE_TOOLS` | `0` | Quando `1`, trunca descrições de tools >150 chars para a primeira frase. |

O runner loga `[coder] turn=N input=X cache_hit=Y ratio=Z%` por turno e emite warning se o ratio cair abaixo de 40% após o turno 3.

### Persistência de cache e métricas (v3.7)

A migration **005 (`coder_cache_tokens`)** adiciona 4 colunas aditivas (todas
default 0, idempotentes):

- `coder_sessions.total_cache_read_tokens`, `total_cache_creation_tokens`
- `coder_messages.cache_read_tokens`, `cache_creation_tokens`

`SessionStore.bumpUsage()` agora aceita 5 args (cache read/creation default 0)
e `appendMessage()` aceita os campos no objeto `usage`. As duas chamadas em
`runCoder` (turno do assistente em `message_complete` e subagente em
`tool_call_result`) propagam `cache_read_input_tokens` e
`cache_creation_input_tokens` — então **cache acumulado por subagentes
também conta no totalizador da sessão pai**.

O endpoint `GET /api/coder/sessions/:id/stats` expõe `CoderSessionStats`:

```ts
{
  total_input_tokens, total_output_tokens,
  total_cache_read_tokens, total_cache_creation_tokens,
  message_count, assistant_turns,
  tool_call_count, tool_error_count, distinct_tools, subagent_call_count,
  total_tool_duration_ms, duration_ms
}
```

Calculado em ~1ms via 3 queries enxutas (sessão, mensagens, JOIN com
tool_calls). O dashboard puxa esses dados no `useEffect` ao selecionar a
sessão e a cada `done` event do stream.

## Configuração

- Config: `.mcp-indexer.json` na raiz
- Ignore: `.mcpindexignore` (sintaxe gitignore)
- Provider padrão: ZAI / glm-5.1
- Dashboard: `http://localhost:3333`
- Banco: SQLite + FTS5 + Cloudflare Vectorize
