# MCP Code Indexer v3.11

Plataforma de indexacao de codebases usando LLMs com busca hibrida (FTS5 + vector embeddings), MCP Server para integracao com Claude Code, dashboard web, memoria de contexto, grafo de dependencias, call graph, hierarquia de symbols, metadata arquitetural, file watching, webhooks, export de docs, diff de versoes e tracking de custos. Alem do indexer, inclui um **Coder Agent** multi-provider com 60+ tools, sistema de tiers, LSP in-process, plugin hooks, e dashboard com chat persistente.

## Novidades v3.11 — Coder Agent overhaul

Esta release refaz a camada do coder agent inspirada no opencode, mantendo os diferenciais do indexer (cache telemetry, snapshots, overlay de sessao).

### Sistema de tiers — reducao de ~70% no prompt inicial
- **Tiers de tools**: `bootstrap` (17 tools essenciais de leitura/busca), `navigate` (+35 tools de edicao/shell/nav profunda), `admin` (+14 tools de git mutations, snapshots, index). Uma sessao nova envia apenas `bootstrap` no turno 1.
- **Promocao mid-sessao**: tool `expand_toolset({tier})` desbloqueia tiers superiores sob demanda — o cache do prefix quebra UMA vez, depois re-estabiliza.
- **Profiles**: `bootstrap | navigate | full | auto`. Auto usa um classificador regex (`inferProfileFromMessage`) sobre a primeira mensagem para escolher o profile. Env `CODER_PROFILE` ou flag `--profile`.
- **Monotonico**: tiers nunca encolhem mid-sessao. Sessoes resumidas sobem direto pra `full`.

### Agent presets de primeira classe
Quatro presets `explore`, `plan`, `build`, `admin` bundlam profile + plan mode + max_turns:

```bash
mcp-code-indexer agent --agent explore "how does the runner loop work?"
mcp-code-indexer agent --agent plan "migrate auth to JWT"
mcp-code-indexer agent --agent build "fix the typo in runner.ts"
mcp-code-indexer agent --agent admin "commit these changes"
```

No dashboard, o novo **AgentPicker** na toolbar do chat:
- Combobox com as 4 opcoes + icones (Compass / ClipboardList / Hammer / ShieldAlert)
- **Intent hint automatico**: debounced `POST /api/coder/classify-intent` enquanto o usuario digita; mostra um link `✨ try build` quando a heuristica recomenda um agent diferente (nunca muta o selecionado sozinho)

### LSP Phase 2 — language service in-process
Quatro tools novas no tier `navigate`, usando o TypeScript Compiler API direto (sem spawnar tsserver):
- `lsp_definition(file, line, column)` — go-to-definition semantico
- `lsp_references(file, line, column)` — find usages com flag `[write]`
- `lsp_hover(file, line, column)` — tipo inferido + JSDoc
- `lsp_diagnostics(file)` — syntactic + semantic diagnostics por arquivo, muito mais rapido que `tsc --noEmit` do projeto

Um `TsLanguageService` por projeto, cached entre sessoes. Linha e coluna sao **1-based** pra bater com editores e stack traces.

Para Python/Go/Rust: `get_diagnostics` (Phase 1) fallback shell para `ruff check` / `go vet` / `cargo check`, cacheado por mtime.

### Tool output side-files — truncagem nao-destrutiva
Quando uma tool passa do `PUSH_TIME_CAP` (default 8k chars), o conteudo integral vai pra `.mcp-indexer/coder/tool-outputs/{session}/{hash}.txt` e a historia recebe um marker deterministico com `output_id`. O agent pode recuperar via `get_tool_output({output_id})` sob demanda. GC automatico de arquivos >7 dias.

### Summarizer de compaction (opt-in)
`CODER_SUMMARIZER_ENABLE=1` ativa um summarizer LLM que roda uma vez por sessao quando o historico excede `PRUNE_MINIMUM`. Substitui N mensagens antigas por **uma** sintetica com resumo estruturado (`what_done`, `current_work`, `files_touched`, `decisions`, `next_steps`). Fallback robusto: qualquer erro cai no path deterministico existente.

### run_command_pty (opcional)
Tool nova que roda comandos num pseudo-terminal real via `node-pty` (dynamic import — nao e dependencia forte). Use para REPLs, ncurses, prompts interativos. Suporta `stdin: string[]` para responder prompts sequencialmente. Se `node-pty` nao estiver instalado, devolve erro com instrucoes claras.

```bash
npm install node-pty   # opcional
```

### Anti-pattern descriptions
Descricoes de tool reescritas no estilo opencode (`USE` / `DON'T`) para treinar o modelo a rotear certo. Exemplo:
```
run_command:
  USE: tests, builds, linters, formatters.
  DON'T: cat/head/tail → use read_file.
  DON'T: grep/rg → use mcp__grep_code.
  DON'T: find/ls → use mcp__list_directory.
  DON'T: sed/awk → use edit_file.
```
Reducao de ~40% em chamadas de tool "erradas" em testes informais.

### Prompts em arquivos .txt
`src/core/coder/prompts/base.txt`, `plan.txt`, `summarize.txt`. O `system-prompt.ts` virou um montador/interpolador — editar prompts nao exige mais rebuild. Em dev, `CODER_PROMPTS_WATCH=1` faz hot-reload.

### Plugin hooks por projeto
- `.mcp-indexer/hooks/system-prompt.js` — `(ctx) => string` appendado ao prompt final
- `.mcp-indexer/hooks/tool-filter.js` — `({tools, ctx}) => string[]` allowlist final das tools

Ambos rodam em `node:vm` com timeout 200ms. Permite customizar o agent por projeto sem forkar o coder.

### Capability-aware tool filtering
`src/core/coder/providers/capabilities.ts` tem um mapa `model → {maxTools, note}`:
- `glm-5.1` → 50 tools (confusao acima)
- `deepseek-chat` → 40
- `gpt-4o-mini` → 64
- `claude-sonnet-4-6` / `claude-opus-4-6` → 200

O runner capa o tools array no topo quando o modelo estiver abaixo do count total. Override via `CODER_MODEL_CAPS` (JSON).

### Novos endpoints HTTP
- `GET /api/coder/agents` — lista os 4 presets + `TIER_COUNTS` pro dashboard
- `POST /api/coder/classify-intent` `{message}` → `{agent, profile, confidence}` — regex classifier sub-ms

### Flags/envs novas
| Env | Default | Funcao |
|---|---|---|
| `CODER_PROFILE` | (auto por contexto) | `bootstrap \| navigate \| full \| auto` |
| `CODER_LOG_TOOLS_COUNT=1` | off | Log da contagem de tools por turno |
| `CODER_SUMMARIZER_ENABLE=1` | off | Opt-in summarizer LLM |
| `CODER_TOOL_OUTPUT_TTL_DAYS` | 7 | GC dos side-files |
| `CODER_MODEL_CAPS` | (built-in) | JSON override do capability map |
| `CODER_PROMPTS_WATCH=1` | off | Hot-reload de prompts em dev |

### Total de tools por tier
- **bootstrap**: 17 (`mcp__get_project_pulse`, `mcp__search`, `mcp__grep_code`, `read_file`, `expand_toolset`, `get_tool_output`, `ask_user`, `submit_plan`, `submit_tasks`, etc.)
- **navigate**: +35 (edit/write/git-read/LSP/diagnostics/pty/spawn_subagent/MCP nav profunda)
- **admin**: +14 (git_commit, add_snapshot, index_project, delete_*, costs)
- **Total full**: 66 tools

## Novidades v3.3

- **Versao unificada** — alinhamento de versao em package.json, CLI, MCP server, README e CLAUDE.md
- **Migrations de schema** — runner de migrations versionadas via tabela `schema_version`
- **Identidade estavel de simbolos** — coluna `stable_id` (hash de kind+name+parent+signature, sem `line`) evita colisoes em codebases com nomes repetidos
- **Desambiguacao de simbolos** — tools como `find_references`, `get_symbol_body`, `prepare_edit` aceitam `file_path` e `symbol_id` para desambiguacao
- **Snapshots com invalidacao** — snapshots podem referenciar arquivos e retornam flag `stale: true` quando os hashes divergem
- **Token budget garantido** — tetos explicitos em `get_file_skeleton`, `prepare_edit`, `get_project_overview`, com flag `truncated` nas respostas
- **Cap em prepare_edit** — callers ordenados por proximidade, truncados com contador, evita estouro em simbolos populares
- **Respostas estruturadas opcionais** — parametro `format: "text" | "json"` nas tools mais consumidas por agentes
- **Custos separados** — tracking separado de LLM analysis vs embeddings; estimate vs actual
- **Resolver de imports melhorado** — suporte a aliases de `tsconfig.compilerOptions.paths`, `index.*`, extensoes multiplas
- **Remocao de `(db as any)`** — metodos explicitos no `CodeIndexDB` substituem acesso direto a internals
- **Suite de testes** — vitest cobrindo DB, FTS5, scanner, code-reader, providers, hybrid search, indexacao incremental e contrato MCP
- **Minimatch como dependencia direta** — corrigido import sem declaracao em `package.json`
- **41 MCP tools** — total atualizado

## Requisitos

- Node.js >= 20
- Uma API key de LLM (ZAI, Anthropic, OpenAI, OpenRouter, DeepSeek ou Gemini)
- (Opcional) Cloudflare account para embeddings/vector search

## Instalacao

```bash
npm install
npm run build
```

## Configuracao

### Arquivo `.env`

```env
# LLM Provider (configure pelo menos uma)
ZAI_API_KEY=sua-chave
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...
# DEEPSEEK_API_KEY=sk-...
# GEMINI_API_KEY=AI...

# Indexer
MCP_INDEX_PROVIDER=zai
MCP_INDEX_MODEL=glm-5.1
MCP_INDEX_CONCURRENCY=5
MCP_INDEX_PORT=3333

# Budget (opcional, em USD)
MCP_INDEX_BUDGET=1.00

# Cloudflare Embeddings (opcional)
MCP_INDEX_EMBEDDINGS=true
MCP_INDEX_WORKER_URL=https://mcp-indexer-worker.seu-account.workers.dev
MCP_INDEX_WORKER_TOKEN=seu-token
```

### Arquivo `.mcp-indexer.json`

Gerado automaticamente com `mcp-code-indexer init`:

```json
{
  "provider": "zai",
  "model": "glm-5.1",
  "concurrency": 5,
  "maxFileSize": 200,
  "ignorePatterns": ["*.test.*", "*.spec.*"],
  "embeddings": {
    "enabled": true,
    "workerUrl": "https://...",
    "workerToken": "..."
  },
  "watcher": { "enabled": false, "debounce": 2000, "autoIndex": true },
  "webhooks": [],
  "costTracking": true,
  "budget": 1.00,
  "dashboard": { "port": 3333, "host": "0.0.0.0" }
}
```

### Arquivo `.mcpindexignore`

Arquivo opcional na raiz do projeto (similar ao `.gitignore`) para excluir arquivos e pastas da indexação. Usa a mesma sintaxe do `.gitignore`. Gerado automaticamente com `mcp-code-indexer init`.

```gitignore
# Dependências
node_modules/
vendor/
.venv/

# Build output
dist/
build/
out/

# Testes (descomente para pular)
# *.test.*
# *.spec.*

# Arquivos gerados
# *.generated.*

# Assets grandes
*.min.js
*.min.css
*.map
*.bundle.js

# Secrets
.env
.env.*
*.pem
*.key
```

**Ordem de prioridade dos ignore rules:**
1. Padrões internos (node_modules, .git, dist, etc.)
2. `ignorePatterns` do `.mcp-indexer.json`
3. `.gitignore` do projeto
4. `.mcpindexignore` do projeto (maior prioridade)

### Providers suportados

| Provider | Env Var | Modelo padrao | Endpoint |
|----------|---------|---------------|----------|
| ZAI (Zhipu) | `ZAI_API_KEY` | glm-5.1 | Auto-detect (coding/general) |
| Anthropic | `ANTHROPIC_API_KEY` | claude-haiku-4-5-20251001 | api.anthropic.com |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini | api.openai.com |
| OpenRouter | `OPENROUTER_API_KEY` | ~openai/gpt-latest | openrouter.ai/api/v1 |
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-chat | api.deepseek.com |
| Gemini | `GEMINI_API_KEY` | gemini-2.0-flash | generativelanguage.googleapis.com |

## CLI - Comandos

### Projetos

```bash
# Listar projetos
mcp-code-indexer projects list

# Adicionar projeto
mcp-code-indexer projects add meu-projeto /caminho/do/projeto -d "Descricao"

# Remover projeto
mcp-code-indexer projects remove meu-projeto

# Info do projeto
mcp-code-indexer projects info meu-projeto
```

### Indexacao

```bash
# Indexar diretorio atual
mcp-code-indexer index

# Indexar path especifico
mcp-code-indexer index /caminho/do/projeto

# Com opcoes
mcp-code-indexer index -p zai -m glm-5.1 -c 10
mcp-code-indexer index --force  # re-indexar tudo

# Com limite de custo
mcp-code-indexer index --budget 0.50
```

### Busca

```bash
# Busca hibrida (FTS5 + vector)
mcp-code-indexer search "autenticacao de usuarios"

# Busca em projeto especifico
mcp-code-indexer search "database connection" -p meu-projeto

# Modo FTS only
mcp-code-indexer search "handleRequest" --mode fts

# Modo vector only
mcp-code-indexer search "como funciona o cache" --mode vector

# Filtrar por tipo
mcp-code-indexer search "User" --type symbols
mcp-code-indexer search "config" --type files

# Busca global (todos os projetos)
mcp-code-indexer search "error handling" -g

# Limitar resultados
mcp-code-indexer search "routing" -l 5
```

### Consultas

```bash
# Detalhes de arquivo
mcp-code-indexer file meu-projeto src/index.ts

# Detalhes de symbol por ID
mcp-code-indexer symbol 42

# Membros de uma classe
mcp-code-indexer class UserService -p meu-projeto

# Buscar por conceito
mcp-code-indexer concept meu-projeto "authentication"

# Listar arquivos
mcp-code-indexer list meu-projeto
mcp-code-indexer list meu-projeto -l typescript

# Estatisticas
mcp-code-indexer stats meu-projeto

# Historico de runs
mcp-code-indexer runs meu-projeto
```

### Dependencias e Arquitetura

```bash
# Dependencias de um arquivo (imports)
mcp-code-indexer deps meu-projeto src/store/db.ts

# Arquivos que dependem de um arquivo
mcp-code-indexer dependents meu-projeto src/types.ts

# Referencias a um symbol
mcp-code-indexer references meu-projeto CodeIndexDB

# Hierarquia de um symbol (extends/implements/subclasses)
mcp-code-indexer hierarchy meu-projeto IndexAgent
```

### Snapshots (Memoria de Contexto)

```bash
# Listar snapshots
mcp-code-indexer snapshots list meu-projeto
mcp-code-indexer snapshots list meu-projeto -c architecture

# Criar snapshot
mcp-code-indexer snapshots add meu-projeto \
  -t "Auth Flow" \
  -c architecture \
  --content "O sistema usa JWT com refresh tokens..."

# Editar snapshot
mcp-code-indexer snapshots edit 1 --content "Atualizado..."

# Remover snapshot
mcp-code-indexer snapshots remove 1

# Ver contexto completo (markdown formatado)
mcp-code-indexer context meu-projeto
```

Categorias: `architecture`, `decision`, `convention`, `pattern`, `todo`, `note`

### Diff entre Versoes

```bash
# Diff entre ultimas duas runs
mcp-code-indexer diff meu-projeto

# Diff entre runs especificas
mcp-code-indexer diff meu-projeto --run-before 1 --run-after 3
```

### Custos

```bash
# Custos de um projeto
mcp-code-indexer costs show meu-projeto

# Custos globais
mcp-code-indexer costs show

# Filtrar por data
mcp-code-indexer costs show --since 2025-01-01

# Estimar custo de indexacao
mcp-code-indexer costs estimate meu-projeto
mcp-code-indexer costs estimate meu-projeto -p anthropic -m claude-haiku-4-5-20251001
```

### Export

```bash
# Export completo em markdown
mcp-code-indexer export meu-projeto

# Export para arquivo
mcp-code-indexer export meu-projeto -o docs.md

# Export JSON
mcp-code-indexer export meu-projeto --format json

# Secoes especificas
mcp-code-indexer export meu-projeto -s "overview,files,symbols"

# Com snapshots
mcp-code-indexer export meu-projeto --include-snapshots
```

Secoes: `overview`, `files`, `symbols`, `dependencies`, `concepts`, `costs`, `snapshots`, `runs`

### Watch (File Watching)

```bash
# Watch projeto especifico
mcp-code-indexer watch meu-projeto

# Watch todos os projetos
mcp-code-indexer watch --all
```

### Webhooks

```bash
# Listar webhooks
mcp-code-indexer webhooks list

# Adicionar webhook
mcp-code-indexer webhooks add https://example.com/hook \
  -p meu-projeto \
  -e "index.done,index.failed" \
  -s "meu-secret"

# Remover webhook
mcp-code-indexer webhooks remove 1

# Testar webhook
mcp-code-indexer webhooks test 1
```

Eventos: `index.done`, `index.failed`, `watch.changed`

### Modelos

```bash
# Listar modelos disponiveis
mcp-code-indexer models

# Filtrar por provider
mcp-code-indexer models -p zai

# Forcar descoberta live
mcp-code-indexer models --live
```

### Utilitarios

```bash
# Criar arquivo de config padrao
mcp-code-indexer init

# Iniciar servidor REST API + Dashboard
mcp-code-indexer serve
mcp-code-indexer serve --port 4000
```

## MCP Server (Claude Code)

### Configuracao

Adicione ao `claude_desktop_config.json` ou `.claude/settings.json`:

```json
{
  "mcpServers": {
    "code-indexer": {
      "command": "node",
      "args": ["F:/CodeStudio/MCP-CodeBase/dist/mcp/server.js"],
      "env": {
        "ZAI_API_KEY": "sua-chave"
      }
    }
  }
}
```

### Tools MCP disponiveis (29)

| Tool | Descricao |
|------|-----------|
| `list_projects` | Listar projetos indexados |
| `index_project` | Indexar/re-indexar projeto |
| `search` | Busca hibrida em projeto |
| `search_global` | Busca em todos os projetos |
| `search_concepts` | Buscar por conceito |
| `search_by_kind` | Buscar symbols por kind (function, class, interface, etc.) |
| `get_file_structure` | Detalhes de arquivo + symbols |
| `get_symbol_details` | Detalhes de symbol |
| `get_class_members` | Membros de classe |
| `get_project_overview` | Overview do projeto |
| `get_project_stats` | Estatisticas |
| `get_project_context` | Contexto (snapshots) |
| `list_snapshots` | Listar snapshots |
| `add_snapshot` | Criar snapshot |
| `update_snapshot` | Editar snapshot |
| `delete_snapshot` | Remover snapshot |
| `get_snapshot_history` | Historico de versoes de um snapshot |
| `get_diff` | Diff entre runs |
| `get_costs` | Custos |
| `estimate_cost` | Estimar custo |
| `export_docs` | Exportar documentacao |
| `list_models` | Listar modelos |
| `delete_project` | Deletar projeto |
| `get_dependencies` | Dependencias de um arquivo (imports) |
| `get_dependents` | Arquivos que dependem de um arquivo |
| `find_references` | Encontrar referencias a um symbol |
| `get_hierarchy` | Hierarquia de symbol (extends/implements/subclasses) |
| `find_implementations` | Encontrar implementacoes de uma interface |
| `get_architecture` | Overview de arquitetura (arquivos por layer) |

## REST API

```bash
# Iniciar servidor
npm run start:api
# ou
mcp-code-indexer serve
```

Roda em `http://localhost:3333` por padrao.

### Endpoints

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/api/projects` | Listar projetos |
| POST | `/api/projects` | Criar projeto |
| GET | `/api/projects/:id` | Info do projeto |
| DELETE | `/api/projects/:id` | Remover projeto |
| POST | `/api/projects/:id/index` | Indexar projeto |
| GET | `/api/projects/:id/files` | Listar arquivos |
| GET | `/api/projects/:id/stats` | Estatisticas |
| GET | `/api/projects/:id/search?q=` | Busca em projeto |
| GET | `/api/search?q=` | Busca global |
| GET | `/api/projects/:id/concepts` | Listar conceitos |
| GET | `/api/projects/:id/concepts/:concept` | Arquivos por conceito |
| GET | `/api/projects/:id/dependencies?file=` | Dependencias de um arquivo |
| GET | `/api/projects/:id/dependents?file=` | Dependentes de um arquivo |
| GET | `/api/projects/:id/circular-deps` | Dependencias circulares |
| GET | `/api/projects/:id/references?symbol=` | Referencias a um symbol |
| GET | `/api/projects/:id/hierarchy?symbol=` | Hierarquia de um symbol |
| GET | `/api/projects/:id/architecture` | Overview por layer |
| GET | `/api/projects/:id/snapshots` | Listar snapshots |
| POST | `/api/projects/:id/snapshots` | Criar snapshot |
| PUT | `/api/snapshots/:id` | Editar snapshot |
| DELETE | `/api/snapshots/:id` | Remover snapshot |
| GET | `/api/snapshots/:id/history` | Historico de versoes do snapshot |
| GET | `/api/projects/:id/context` | Contexto (markdown) |
| GET | `/api/projects/:id/diff` | Diff entre runs |
| GET | `/api/projects/:id/runs` | Historico de runs |
| GET | `/api/projects/:id/costs` | Custos do projeto |
| GET | `/api/costs` | Custos globais |
| POST | `/api/projects/:id/costs/estimate` | Estimar custo |
| POST | `/api/projects/:id/export` | Exportar documentacao |
| GET | `/api/models` | Listar modelos |
| GET | `/api/webhooks` | Listar webhooks |
| POST | `/api/webhooks` | Criar webhook |
| DELETE | `/api/webhooks/:id` | Remover webhook |
| POST | `/api/webhooks/:id/test` | Testar webhook |

## Dashboard Web

```bash
# Desenvolvimento
npm run dev

# Producao
npm run build:all
mcp-code-indexer serve
```

Acesse `http://localhost:3333`. Tabs disponiveis por projeto:
- **Search** — busca hibrida com filtros de modo e tipo
- **Files** — lista de arquivos com language, lines, layer, complexity e flags (entry-point/test/generated)
- **Dependencies** — explorar dependencias (imports), dependentes e dependencias circulares
- **Architecture** — visualizacao de arquivos por layer com barras proporcionais
- **Snapshots** — editor de snapshots com historico de versoes
- **Diff** — comparacao entre runs de indexacao
- **Costs** — tracking de custos com graficos
- **Runs** — historico de execucoes

## Variaveis de Ambiente

| Variavel | Descricao | Default |
|----------|-----------|---------|
| `ZAI_API_KEY` | API key Zhipu AI | - |
| `ANTHROPIC_API_KEY` | API key Anthropic | - |
| `OPENAI_API_KEY` | API key OpenAI | - |
| `OPENROUTER_API_KEY` | API key OpenRouter | - |
| `DEEPSEEK_API_KEY` | API key DeepSeek | - |
| `GEMINI_API_KEY` | API key Google Gemini | - |
| `MCP_INDEX_DB` | Caminho do banco SQLite | `~/.mcp-code-indexer/index.db` |
| `MCP_INDEX_PROVIDER` | Provider padrao | `zai` |
| `MCP_INDEX_MODEL` | Modelo padrao | - |
| `MCP_INDEX_CONCURRENCY` | Concorrencia de indexacao | `5` |
| `MCP_INDEX_PORT` | Porta do dashboard/API | `3333` |
| `MCP_INDEX_BUDGET` | Limite de custo em USD | - |
| `MCP_INDEX_EMBEDDINGS` | Habilitar embeddings (`true`/`false`) | `false` |
| `MCP_INDEX_WORKER_URL` | URL do Cloudflare Worker | - |
| `MCP_INDEX_WORKER_TOKEN` | Token de auth do Worker | - |

## Cloudflare Worker (Embeddings)

O worker prove embeddings via Cloudflare Workers AI (`@cf/baai/bge-m3`) e armazenamento vetorial via Vectorize.

### Deploy

```bash
cd worker
npm install
npx wrangler secret put AUTH_TOKEN  # definir token
npx wrangler deploy
```

### Endpoints do Worker

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/health` | Health check (sem auth) |
| POST | `/embed` | Gerar embeddings |
| POST | `/upsert` | Inserir vetores |
| POST | `/search` | Buscar vetores |
| POST | `/delete` | Deletar vetores |

Todos os endpoints (exceto `/health`) requerem header `Authorization: Bearer <token>`.

## Scripts npm

| Script | Descricao |
|--------|-----------|
| `npm run build` | Compilar TypeScript |
| `npm run build:dashboard` | Build do dashboard (Vite) |
| `npm run build:all` | Build completo (TS + dashboard) |
| `npm run dev` | Dev server (API + dashboard) |
| `npm run dev:server` | Dev server (apenas API) |
| `npm run dev:dashboard` | Dev server (apenas dashboard) |
| `npm start` | CLI |
| `npm run start:server` | MCP Server |
| `npm run start:api` | REST API Server |

## Arquitetura

```
src/
  agent/           # Scanner + IndexAgent + Providers
    providers/     # Anthropic, OpenAI, DeepSeek, Gemini, ZAI
  api/             # Hono REST API
  dashboard/       # React SPA (Vite + Tailwind v4)
  mcp/             # MCP Server (stdio)
  search/          # Hybrid search (FTS5 + Vector + RRF)
  services/        # Costs, Snapshots, Watcher, Webhooks, Exporter, Differ
  store/           # SQLite (better-sqlite3) + Cloudflare Vectorize
  utils/           # Config loader
  types.ts         # Todas as interfaces
worker/            # Cloudflare Worker (embeddings + vectorize)
```

### Tabelas do banco

| Tabela | Descricao |
|--------|-----------|
| `projects` | Projetos registrados |
| `files` | Arquivos indexados (com layer, is_entry_point, is_test, is_generated) |
| `symbols` | Symbols extraidos (funcoes, classes, interfaces, etc.) |
| `file_concepts` | Conceitos por arquivo (normalizado) |
| `file_dependencies` | Grafo de dependencias (imports internos/externos) |
| `symbol_references` | Call graph (quais arquivos referenciam quais symbols) |
| `symbol_relations` | Hierarquia (extends/implements) |
| `snapshots` | Memoria de contexto |
| `snapshot_versions` | Historico de versoes de snapshots |
| `runs` | Execucoes de indexacao |
| `run_costs` | Custos por run |
| `webhooks` | Configuracao de webhooks |
| `files_fts` | FTS5 para busca em arquivos |
| `symbols_fts` | FTS5 para busca em symbols |
| `snapshots_fts` | FTS5 para busca em snapshots |

### Workers
```bash 
cd worker
npx wrangler vectorize create-metadata-index code-index --property-name=project_name --type=string
npx wrangler vectorize create-metadata-index code-index --property-name=type --type=string
```



## Licenca

MIT
